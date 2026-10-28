import crypto from 'node:crypto';
import { CAPTURE_POLICY_VERSION } from '../agent-config.js';
import { enableCapture, disableCapture, buildDigestPayload, collectGitMetadata, serializeDigestPayload, MAX_DIGEST_BYTES, MAX_DIGEST_CHARS, readProjectCaptureRestrictions, captureProjectKey, captureProjectBindingConflict, queueProjectRoots, CAPTURE_DISCLOSURE, captureReconsentCommand, captureConsentActive, captureConsentOutdated, consentRevisionAllowsRequeue, queuedDigestCarriesPrompts, resolveCaptureWorkspaceId, } from '../runtime/capture.js';
import { readPreferences, resolveStateDir } from '../runtime/storage.js';
import { listQueueItems, updateQueueItem } from '../runtime/queue.js';
import { flushCaptureQueue, queueItemFailureClass, readCaptureStatus, MAX_CAPTURE_ATTEMPTS, } from '../runtime/flush.js';
import { SessionLockTimeoutError, withSessionLock } from '../runtime/lock.js';
import { previewCapturePurge, purgeCaptureLocalState } from '../runtime/retention.js';
import { loadMostRecentSessionLedger, queueSessionCapture, sessionSliceDigestId } from '../runtime/session.js';
import { CLI_EXIT_CODES, isWorkspaceUuid, normalizeWorkspaceId, } from '../lib/cli-contracts.js';
import { WORKSPACE_UUID_REQUIRED } from '../lib/config.js';
import { ApiClient } from '../lib/api-client.js';
import { createDefaultCredentialStore } from '../lib/credentials.js';
export function captureStatus(options) {
    const prefs = readPreferences(options?.baseDir);
    const queue = listQueueItems(options?.baseDir);
    const count = (status) => queue.filter((item) => item.status === status).length;
    // Retention deletes delivered items, so capture-status.json keeps the last
    // delivery. Hook runtimes pinned before 0.1.29 deliver without updating it
    // until `init` reruns, so report the later of the file and the queue.
    const lastSuccessfulDeliveryAt = [
        readCaptureStatus(options?.baseDir)?.lastSuccessfulDeliveryAt,
        ...queue.filter((item) => item.status === 'delivered').map((item) => item.deliveredAt),
    ]
        .filter((at) => typeof at === 'string' && Number.isFinite(Date.parse(at)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1) ?? null;
    const data = {
        enabled: Boolean(prefs?.consent?.captureEnabled),
        // Consent to an earlier policy version: capture is paused until `capture enable` accepts the current one.
        reconsentRequired: captureConsentOutdated(prefs),
        ...(captureConsentOutdated(prefs) ? { reconsentCommand: captureReconsentCommand(prefs) } : {}),
        currentPolicyVersion: CAPTURE_POLICY_VERSION,
        includePrompts: Boolean(prefs?.consent?.includePrompts),
        policyVersion: prefs?.consent?.policyVersion ?? CAPTURE_POLICY_VERSION,
        consentedAt: prefs?.consent?.consentedAt ?? null,
        consentRevision: prefs?.consent?.revision ?? 0,
        workspaceId: prefs?.enabledWorkspaceId ?? null,
        maxBytesPerDigest: MAX_DIGEST_BYTES,
        maxCharsPerDigest: MAX_DIGEST_CHARS,
        lastSuccessfulDeliveryAt,
        queue: {
            total: queue.length,
            pending: count('pending'),
            sending: count('sending'),
            failed: count('failed'),
            cancelled: count('cancelled'),
            deliveryUnknown: count('delivery_unknown'),
            delivered: count('delivered'),
        },
    };
    return { exitCode: CLI_EXIT_CODES.SUCCESS, data };
}
export async function captureEnable(options) {
    const explicitWorkspace = options?.workspace === undefined ? undefined : normalizeWorkspaceId(options.workspace);
    if (explicitWorkspace && !isWorkspaceUuid(explicitWorkspace)) {
        return {
            exitCode: CLI_EXIT_CODES.USAGE_ERROR,
            data: { enabled: false, message: WORKSPACE_UUID_REQUIRED },
        };
    }
    let kind;
    let scopes = [];
    let workspaces = [];
    let defaultWorkspaceId;
    let workspaceId;
    try {
        let apiClient = options?.apiClient;
        if (!apiClient) {
            const store = options?.store ?? (await createDefaultCredentialStore({
                baseDir: options?.baseDir,
                allowFileCredentials: true,
                warn: () => undefined,
            })).store;
            apiClient = new ApiClient({ store });
        }
        const creds = await apiClient.getEffectiveCredentials();
        kind = creds?.authType;
        scopes = Array.isArray(creds?.scopes)
            ? creds.scopes.filter((item) => typeof item === 'string')
            : [];
        workspaces = Array.isArray(creds?.workspaces)
            ? creds.workspaces.filter((item) => typeof item === 'string')
            : [];
        defaultWorkspaceId = creds?.defaultWorkspaceId;
    }
    catch {
        kind = undefined;
    }
    if (kind === 'service' || (!kind && process.env.BRAINMCP_SERVICE_TOKEN)) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                enabled: false,
                message: 'Service tokens cannot enable automatic lifecycle capture. Use an OAuth companion login with --capture-digests.',
            },
        };
    }
    if (!kind) {
        return {
            exitCode: CLI_EXIT_CODES.AUTH_REQUIRED,
            data: {
                enabled: false,
                message: 'Capture was not enabled. Sign in with `brainmcp login --capture-digests` and complete browser consent first.',
            },
        };
    }
    if (kind === 'oauth' && !scopes.includes('digests:write')) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                enabled: false,
                message: 'Capture requires the digests:write scope. Re-run `brainmcp login --capture-digests` and approve digest capture in the browser.',
            },
        };
    }
    if (kind === 'oauth' && workspaces.length === 0) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                enabled: false,
                message: 'Capture requires an explicit workspace allowlist on the current CLI grant. Re-login and approve workspace access.',
            },
        };
    }
    if (explicitWorkspace && !workspaces.includes(explicitWorkspace)) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                enabled: false,
                message: 'The selected workspace is not in this CLI authorization allowlist.',
            },
        };
    }
    workspaceId = [
        explicitWorkspace,
        typeof defaultWorkspaceId === 'string' && workspaces.includes(defaultWorkspaceId)
            ? defaultWorkspaceId
            : undefined,
        workspaces.length === 1 ? workspaces[0] : undefined,
    ]
        .find((id) => typeof id === 'string' && isWorkspaceUuid(id.trim()))
        ?.trim();
    if (kind === 'oauth' && scopes.includes('digests:write') && !workspaceId) {
        return {
            exitCode: CLI_EXIT_CODES.CONFIGURATION_ERROR,
            data: {
                enabled: false,
                message: 'Capture needs a target workspace. Pass --workspace <uuid> or re-login so the grant has a default workspace.',
            },
        };
    }
    const updated = enableCapture({
        baseDir: options?.baseDir,
        includePrompts: options?.includePrompts,
        workspaceId,
    });
    return {
        exitCode: CLI_EXIT_CODES.SUCCESS,
        data: {
            enabled: true,
            includePrompts: Boolean(updated.consent.includePrompts),
            policyVersion: updated.consent.policyVersion,
            workspaceId: updated.enabledWorkspaceId ?? null,
            disclosure: CAPTURE_DISCLOSURE,
            message: `Digest capture enabled under capture policy ${updated.consent.policyVersion}. ${CAPTURE_DISCLOSURE}`,
        },
    };
}
export function captureDisable(options) {
    const updated = disableCapture({
        baseDir: options?.baseDir,
    });
    return {
        exitCode: CLI_EXIT_CODES.SUCCESS,
        data: {
            enabled: false,
            includePrompts: false,
            policyVersion: updated.consent.policyVersion,
            message: 'Digest capture disabled and pending automatic items cancelled.',
        },
    };
}
/** Why a manual delivery attempted in this run was not accepted, keyed by the flush retry or failure class. */
function undeliveredCapture(failure) {
    switch (failure) {
        case 'auth_required':
            return {
                exitCode: CLI_EXIT_CODES.AUTH_REQUIRED,
                message: 'Manual capture was refused because the companion sign-in expired or was revoked. Run `brainmcp login --capture-digests`.',
            };
        case 'terminal':
            return {
                exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
                message: 'Manual capture was refused: the grant lacks digest access to this workspace, or server policy disables capture.',
            };
        case 'non_retryable':
            return {
                exitCode: CLI_EXIT_CODES.GENERAL_ERROR,
                message: 'Manual capture was rejected by the server and will not be retried.',
            };
        case 'retry_exhausted':
            // Same retryable code as a transport failure: the next `capture now` resets and resends it.
            return {
                exitCode: CLI_EXIT_CODES.NETWORK_ERROR,
                message: `Manual capture failed after ${MAX_CAPTURE_ATTEMPTS} delivery attempts (network or server errors). Run \`brainmcp capture now\` again to retry it.`,
            };
        default:
            // Transport failures, timeouts, 429/5xx, and a temporary pending-digest cap.
            return {
                exitCode: CLI_EXIT_CODES.NETWORK_ERROR,
                message: 'Manual capture queued but was not accepted. Check `brainmcp capture --status` and doctor.',
            };
    }
}
const RECORD_NEW_ACTIVITY = 'Record new session activity first, then run `brainmcp capture now`.';
/** A slice whose item failed in an earlier run; nothing is resent for it. */
function refusedEarlier(failure) {
    switch (failure) {
        case 'auth_required':
            return {
                exitCode: CLI_EXIT_CODES.AUTH_REQUIRED,
                message: `This session slice was refused earlier because the companion sign-in expired or was revoked. Run \`brainmcp login --capture-digests\`. ${RECORD_NEW_ACTIVITY}`,
            };
        case 'terminal':
            return {
                exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
                message: `This session slice was refused earlier: the grant lacks digest access to this workspace, or server policy disables capture. ${RECORD_NEW_ACTIVITY}`,
            };
        case 'retry_exhausted':
            // Only an automatic item `capture now` could not requeue reaches this (another
            // sign-in or workspace, a consent a disable withdrew, prompts the current
            // consent excludes, or a busy queue); a manual one is reset instead.
            return {
                exitCode: CLI_EXIT_CODES.GENERAL_ERROR,
                message: `The automatic capture of this session slice failed after repeated delivery attempts and could not be requeued: it belongs to another sign-in or to a workspace other than the capture workspace, it was queued before a capture disable (which withdrew it) or carries prompts the current consent excludes, or another BrainMCP process held the queue (retry \`brainmcp capture now\` in a moment). ${RECORD_NEW_ACTIVITY}`,
            };
        default:
            return {
                exitCode: CLI_EXIT_CODES.GENERAL_ERROR,
                message: `This session slice was rejected by the server earlier and will not be resent. ${RECORD_NEW_ACTIVITY}`,
            };
    }
}
const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'sending', 'delivery_unknown']);
function findQueueItem(baseDir, digestId) {
    return listQueueItems(baseDir).find((item) => item.digestId === digestId);
}
function parsedPayload(item) {
    try {
        return JSON.parse(item.digestText);
    }
    catch {
        return item.digestText;
    }
}
/**
 * Send only the given manual items. The manual flush cancels any automatic item
 * it is handed (it has no hook project policy), so callers pass manual IDs only.
 */
function flushManualItems(run, digestIds) {
    return flushCaptureQueue({
        apiClient: run.apiClient,
        baseDir: run.baseDir,
        includeManual: true,
        credentials: run.credentials,
        digestIds,
    });
}
/** An undelivered manual item this run may send: same grant, consent revision, and workspace. */
function isResendableManualItem(run, item) {
    return item.captureTrigger === 'manual' && ACTIVE_QUEUE_STATUSES.has(item.status) &&
        item.authorizationId === run.authorizationId && item.consentRevision === run.consentRevision &&
        item.workspaceId === run.workspaceId;
}
/**
 * Per D5, `capture now` also resends the user's other undelivered manual items
 * for the same grant, consent revision, and workspace. Background flushes never
 * send manual items, so this, `purge-local`, and the 7-day retention are what
 * clear a manual backlog.
 */
async function retryEarlierManualItems(run, excludeDigestId) {
    const digestIds = listQueueItems(run.baseDir)
        .filter((item) => item.digestId !== excludeDigestId && isResendableManualItem(run, item))
        .map((item) => item.digestId);
    const none = { waiting: 0, retried: 0, delivered: 0, failed: 0, stillQueued: 0, requests: 0, queueBusy: false };
    if (digestIds.length === 0)
        return none;
    const flushed = await flushManualItems(run, digestIds);
    const statuses = new Map(listQueueItems(run.baseDir).map((item) => [item.digestId, item.status]));
    const failed = digestIds.filter((digestId) => statuses.get(digestId) === 'failed').length;
    return {
        waiting: digestIds.length,
        retried: flushed.sent + flushed.failed + flushed.unknown,
        delivered: flushed.sent,
        failed,
        stillQueued: Math.max(0, digestIds.length - flushed.sent - failed),
        requests: flushed.requests,
        queueBusy: Boolean(flushed.queueBusy),
    };
}
/**
 * Automatic items of the current sign-in and capture workspace that ran out of
 * retries (items failed by 0.1.38 and earlier runtimes after a short outage,
 * or past the retention window's last retry) go back to `pending`. The
 * exhausted items belong to the sign-in, not to a project, so `capture now`
 * runs this from any project, whatever its ledger or binding says. Only the
 * capture workspace (`enabledWorkspaceId`): the flush cancels an automatic
 * item for any other workspace, so `--workspace` never widens this.
 *
 * An item queued under an earlier consent revision (re-consent to a new
 * capture policy bumps it) is re-stamped to the current one, which the send
 * requires, unless a capture disable may lie between the two
 * (consentRevisionAllowsRequeue): a disable withdrew it, including a failed
 * item an older CLI's disable did not cancel. One that carries prompts the
 * current consent no longer includes stays failed. Only the lifecycle hooks
 * send them, with their project policy; the server deduplicates on
 * clientDigestId if an earlier attempt landed. Preferences are re-read under
 * the queue lock. Returns how many were requeued.
 */
async function requeueExhaustedAutomaticItems(baseDir, credentials) {
    if (credentials?.authType !== 'oauth' || !credentials.authorizationId || credentials.reauthRequired ||
        !credentials.scopes?.includes('digests:write'))
        return 0;
    const authorizationId = credentials.authorizationId;
    try {
        return await withSessionLock('capture-queue', () => {
            const prefs = readPreferences(baseDir);
            const captureWorkspaceId = resolveCaptureWorkspaceId(prefs);
            if (!prefs || !captureConsentActive(prefs) || !captureWorkspaceId || !credentials.workspaces?.includes(captureWorkspaceId))
                return 0;
            const consentRevision = prefs.consent.revision ?? 0;
            let requeued = 0;
            for (const item of listQueueItems(baseDir)) {
                if (item.captureTrigger === 'manual' || item.status !== 'failed' || queueItemFailureClass(item) !== 'retry_exhausted')
                    continue;
                if (item.authorizationId !== authorizationId || item.workspaceId !== captureWorkspaceId)
                    continue;
                if (!consentRevisionAllowsRequeue(item.consentRevision, prefs))
                    continue;
                if (item.consentRevision !== consentRevision && !prefs.consent.includePrompts && queuedDigestCarriesPrompts(item.digestText))
                    continue;
                if (updateQueueItem(item.digestId, {
                    status: 'pending', attempts: 0, nextRetryAt: undefined, failureClass: undefined, lastError: undefined, lastErrorCode: undefined,
                    consentRevision,
                }, baseDir))
                    requeued += 1;
            }
            return requeued;
        }, { baseDir, timeoutMs: 250 });
    }
    catch (error) {
        if (error instanceof SessionLockTimeoutError)
            return 0;
        throw error;
    }
}
function requeuedMessage(requeued) {
    return requeued > 0
        ? ` Requeued ${requeued} automatic capture(s) that had run out of retries; the next lifecycle hook delivers them.`
        : '';
}
/** Deliver or report the slice's queue item according to its current state. */
async function settleSlice(run, item) {
    if (!item) {
        return {
            exitCode: CLI_EXIT_CODES.GENERAL_ERROR,
            captured: false,
            retryEarlier: true,
            message: 'No local delivery record exists for this session slice under the current sign-in. Local retention removes delivered captures ' +
                'at the next session start and undelivered ones after 7 days, `purge-local` removes all of them, and a capture made under another ' +
                `sign-in does not match. \`brainmcp capture --status\` shows the last delivery. ${RECORD_NEW_ACTIVITY}`,
        };
    }
    if (item.status === 'delivered') {
        return {
            exitCode: CLI_EXIT_CODES.SUCCESS,
            captured: false,
            alreadyDelivered: true,
            retryEarlier: true,
            message: 'This session slice was already delivered. Record new session activity to capture more.',
        };
    }
    if (item.status === 'cancelled') {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            captured: false,
            retryEarlier: true,
            message: `This session slice was cancelled before delivery because capture consent, project policy, or the sign-in changed. ${RECORD_NEW_ACTIVITY}`,
        };
    }
    if (item.captureTrigger !== 'manual') {
        if (item.status === 'failed') {
            const failure = queueItemFailureClass(item);
            return { ...refusedEarlier(failure), captured: false, retryEarlier: failure !== 'auth_required' && failure !== 'terminal' };
        }
        // Never hand an automatic item to the manual flush: without the hook's
        // project policy it would cancel the item instead of sending it.
        return {
            exitCode: CLI_EXIT_CODES.NETWORK_ERROR,
            captured: false,
            retryEarlier: true,
            message: 'This session slice is queued as an automatic capture; the next lifecycle hook starts its background delivery. `capture now` sends only manual captures.',
        };
    }
    if (item.status === 'failed') {
        const failure = queueItemFailureClass(item);
        if (failure !== 'retry_exhausted') {
            return { ...refusedEarlier(failure), captured: false, retryEarlier: failure !== 'auth_required' && failure !== 'terminal' };
        }
        // A manual item that ran out of retries is the user's to resend; the
        // server deduplicates on its clientDigestId if an attempt did land.
        const reset = await withSessionLock('capture-queue', () => {
            const current = findQueueItem(run.baseDir, item.digestId);
            if (current?.status !== 'failed' || queueItemFailureClass(current) !== 'retry_exhausted')
                return false;
            return Boolean(updateQueueItem(item.digestId, {
                status: 'pending', attempts: 0, nextRetryAt: undefined, failureClass: undefined, lastError: undefined,
            }, run.baseDir));
        }, { baseDir: run.baseDir, timeoutMs: 250 });
        if (!reset)
            return settleSlice(run, findQueueItem(run.baseDir, item.digestId));
    }
    const flushed = await flushManualItems(run, [item.digestId]);
    const after = findQueueItem(run.baseDir, item.digestId);
    const sent = { flushed, payload: parsedPayload(item) };
    if (flushed.sent > 0) {
        return {
            ...sent,
            exitCode: CLI_EXIT_CODES.SUCCESS,
            captured: true,
            retryEarlier: true,
            message: flushed.bookkeepingErrors
                ? 'Manual capture delivered. Its local queue entry could not be updated, so a later flush resends it; the server ignores the duplicate.'
                : 'Manual capture delivered.',
        };
    }
    if (flushed.queueBusy) {
        return {
            ...sent,
            // Same retryable code as a delivery left queued after a transient failure.
            exitCode: CLI_EXIT_CODES.NETWORK_ERROR,
            captured: false,
            retryEarlier: false,
            message: 'Manual capture is queued, but another BrainMCP process was using the local capture queue. Retry `brainmcp capture now` in a moment.',
        };
    }
    if (after?.status === 'failed') {
        return { ...sent, ...undeliveredCapture(queueItemFailureClass(after)), captured: false, retryEarlier: false };
    }
    if (flushed.requests > 0 || flushed.failed > 0 || flushed.unknown > 0) {
        return { ...sent, ...undeliveredCapture(flushed.lastFailureClass), captured: false, retryEarlier: false };
    }
    // Nothing was attempted: another process holds the delivery lease, or the
    // item is inside its retry backoff.
    const retryAt = after?.nextRetryAt && Date.parse(after.nextRetryAt) > Date.now() ? after.nextRetryAt : undefined;
    return {
        ...sent,
        exitCode: CLI_EXIT_CODES.NETWORK_ERROR,
        captured: false,
        retryEarlier: true,
        message: after?.status === 'sending'
            ? 'Manual capture is being delivered by another BrainMCP process. Check `brainmcp capture --status` in a moment.'
            : retryAt
                ? `Manual capture is queued and waiting for its retry window. Run \`brainmcp capture now\` again after ${retryAt}.`
                : undeliveredCapture(undefined).message,
    };
}
function earlierSummary(earlier) {
    if (earlier.waiting === 0)
        return '';
    const parts = [`${earlier.delivered} delivered`];
    if (earlier.failed)
        parts.push(`${earlier.failed} failed`);
    if (earlier.stillQueued)
        parts.push(`${earlier.stillQueued} still queued`);
    return ` Earlier manual captures for this sign-in: ${parts.join(', ')}.`;
}
/** The queue cap refused a genuinely new slice. Never success: nothing was reserved. */
function queueFullMessage(run, earlier) {
    const manual = listQueueItems(run.baseDir)
        .filter((item) => item.captureTrigger === 'manual' && ACTIVE_QUEUE_STATUSES.has(item.status));
    if (manual.length === 0) {
        return 'Local capture queue is full of automatic captures waiting for delivery. Wait for lifecycle-hook retries, or run `brainmcp capture purge-local`, then run `brainmcp capture now` again.';
    }
    const otherGrant = manual.filter((item) => !isResendableManualItem(run, item)).length;
    return `Local capture queue is full, so this session slice was not queued. ${manual.length} manual capture(s) are waiting; ` +
        'background hooks never send manual captures, so only `brainmcp capture now`, `brainmcp capture purge-local`, or the 7-day local retention clears them.' +
        (otherGrant > 0
            ? ` ${otherGrant} of them belong to an earlier sign-in, capture consent, or workspace, which \`capture now\` cannot send.`
            : '') +
        earlierSummary(earlier);
}
/** One `capture now` run's API client, created on first use and shared by the slice and the requeue. */
function lazyApiClient(options, credentialHome) {
    let client;
    return () => client ??= (async () => options.apiClient ?? new ApiClient({
        store: options.store ?? (await createDefaultCredentialStore({ baseDir: credentialHome, allowFileCredentials: true, warn: () => undefined })).store,
    }))();
}
export async function captureNow(options) {
    const credentialHome = options?.baseDir;
    const stateDir = resolveStateDir(options?.baseDir);
    const resolved = { ...options, baseDir: stateDir };
    const apiClient = lazyApiClient(resolved, credentialHome);
    // The exhausted-item requeue is account-level: it runs once per run, from
    // any project, whatever this project's ledger or binding says (never on a
    // dry run). The slice path runs it after reserving its slice, so a requeue
    // cannot fill the queue cap ahead of it.
    let requeue;
    const requeueOnce = () => requeue ??= resolved.dryRun
        ? Promise.resolve(0)
        : (async () => {
            try {
                return await requeueExhaustedAutomaticItems(stateDir, await (await apiClient()).getEffectiveCredentials());
            }
            catch {
                return 0;
            }
        })();
    const result = await captureSessionSlice(resolved, apiClient, requeueOnce);
    const requeuedAutomatic = await requeueOnce();
    const data = result.data;
    if (requeuedAutomatic > 0 && data.requeuedAutomatic === undefined) {
        data.requeuedAutomatic = requeuedAutomatic;
        data.message = `${String(data.message ?? '')}${requeuedMessage(requeuedAutomatic)}`;
    }
    return result;
}
async function captureSessionSlice(options, getApiClient, requeueOnce) {
    const stateDir = options.baseDir;
    const prefs = readPreferences(options?.baseDir);
    const selectedWorkspace = options?.workspace || prefs?.enabledWorkspaceId;
    const workspaceId = selectedWorkspace === undefined ? undefined : normalizeWorkspaceId(selectedWorkspace);
    const projectKey = captureProjectKey(options.cwd ?? process.cwd());
    const ledger = loadMostRecentSessionLedger(options?.baseDir, projectKey);
    const projectPolicy = readProjectCaptureRestrictions(options.cwd ?? process.cwd());
    if (!ledger) {
        return {
            exitCode: CLI_EXIT_CODES.CONFIGURATION_ERROR,
            data: {
                captured: false,
                dryRun: Boolean(options?.dryRun),
                requestsSent: 0,
                message: 'No local session ledger is available to capture in this project. Run this command after a managed lifecycle hook has recorded session activity.',
            },
        };
    }
    if (!workspaceId) {
        return {
            exitCode: CLI_EXIT_CODES.CONFIGURATION_ERROR,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'Select a workspace with --workspace or set enabledWorkspaceId in preferences before capturing.',
            },
        };
    }
    if (!isWorkspaceUuid(workspaceId)) {
        return {
            exitCode: CLI_EXIT_CODES.CONFIGURATION_ERROR,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'The capture workspace must be a valid workspace UUID.',
            },
        };
    }
    if (!prefs?.consent?.captureEnabled) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'Capture is disabled. Run `brainmcp capture enable` after `brainmcp login --capture-digests`.',
            },
        };
    }
    if (captureConsentOutdated(prefs)) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                captured: false,
                requestsSent: 0,
                reconsentRequired: true,
                reconsentCommand: captureReconsentCommand(prefs),
                message: `Capture is paused: you consented to capture policy ${prefs.consent.policyVersion}, and what capture uploads has changed (policy ${CAPTURE_POLICY_VERSION}). Review it and run \`${captureReconsentCommand(prefs)}\` to accept the current policy${prefs.consent.includePrompts ? ' (--include-prompts keeps your prompt opt-in; without it prompts are no longer captured)' : ''}.`,
            },
        };
    }
    const bindingConflict = captureProjectBindingConflict([options.cwd ?? process.cwd()], workspaceId);
    if (bindingConflict) {
        // Fails closed like the lifecycle hooks: a binding that names no valid
        // workspace never falls back to the capture workspace.
        const message = bindingConflict.kind === 'workspace'
            ? `Manual capture was not queued: ${bindingConflict.configPath} binds this project to workspace ${bindingConflict.workspaceId}, but capture targets workspace ${workspaceId} (ledger workspace: ${ledger.workspaceId ?? 'unbound'}). Record new activity under the intended binding.`
            : `Manual capture was not queued: ${bindingConflict.configPath} has no valid workspaceId (it is not a workspace UUID, or the file is not readable JSON). Set workspaceId to the project's workspace UUID, or remove the file, before capturing.`;
        return { exitCode: CLI_EXIT_CODES.PERMISSION_DENIED, data: { captured: false, requestsSent: 0, message } };
    }
    // Each send rechecks this root's policy, so a root the queue item cannot record is not captured.
    const projectRoots = queueProjectRoots([options.cwd ?? process.cwd()]);
    if (!projectRoots) {
        return { exitCode: CLI_EXIT_CODES.PERMISSION_DENIED, data: { captured: false, requestsSent: 0,
                message: 'Manual capture was not queued: the project path is too long to record for the policy check each send makes.' } };
    }
    if (projectPolicy.captureDisabled || ledger.captureRevision !== (prefs.consent.revision ?? 0) || ledger.workspaceId !== workspaceId) {
        return { exitCode: CLI_EXIT_CODES.PERMISSION_DENIED, data: { captured: false, requestsSent: 0,
                message: 'This ledger is restricted by project policy or belongs to a different capture consent/workspace. Record new activity under the current capture settings.' } };
    }
    const apiClient = await getApiClient();
    const creds = await apiClient.getEffectiveCredentials();
    if (creds?.authType !== 'oauth' ||
        !creds.accessToken ||
        !creds.authorizationId ||
        !creds.scopes?.includes('digests:write')) {
        return {
            exitCode: CLI_EXIT_CODES.AUTH_REQUIRED,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'Manual capture was not queued. Sign in with `brainmcp login --capture-digests` first so it can be bound to the current authorization.',
            },
        };
    }
    // A grant marked for re-login cannot send, so a dry run reports it too.
    if (creds.reauthRequired) {
        return {
            exitCode: CLI_EXIT_CODES.AUTH_REQUIRED,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'Manual capture was not queued. Sign-in expired or was revoked; run `brainmcp login --capture-digests` again so it can be bound to a current authorization.',
            },
        };
    }
    if (!creds.workspaces?.includes(workspaceId)) {
        return {
            exitCode: CLI_EXIT_CODES.PERMISSION_DENIED,
            data: {
                captured: false,
                requestsSent: 0,
                message: 'Manual capture was not queued because the selected workspace is outside the current CLI authorization allowlist.',
            },
        };
    }
    const payload = buildDigestPayload({
        trigger: 'manual',
        workspaceId,
        host: 'manual-cli',
        model: ledger.model,
        summary: ledger.assistantSummary,
        paths: ledger.editedPaths,
        gitMetadata: collectGitMetadata(options?.cwd ?? process.cwd(), { trigger: 'manual', baseDir: options.baseDir }),
        prompts: ledger.prompts,
        includePrompts: prefs?.consent?.includePrompts && !projectPolicy.promptsDisabled,
    });
    if (options?.dryRun) {
        return {
            exitCode: CLI_EXIT_CODES.SUCCESS,
            data: {
                dryRun: true,
                requestsSent: 0,
                payload,
                message: 'Dry run completed. Zero network requests were made. Scrubbing is defense in depth, not consent.',
            },
        };
    }
    const run = {
        apiClient,
        baseDir: stateDir,
        credentials: creds,
        authorizationId: creds.authorizationId,
        consentRevision: prefs.consent.revision ?? 0,
        workspaceId,
    };
    const sliceDigestId = (capturedThroughSequence) => sessionSliceDigestId({ sessionKey: ledger.sessionKey,
        capturedThroughSequence, authorizationId: run.authorizationId, consentRevision: run.consentRevision, workspaceId });
    const sliceSequence = ledger.lastMeaningfulSequence ?? ledger.eventSequence;
    const reserveSlice = () => queueSessionCapture({
        sessionKey: ledger.sessionKey,
        capturedThroughSequence: sliceSequence,
        baseDir: run.baseDir,
        item: {
            digestId: payload.clientDigestId || crypto.randomUUID(),
            workspaceId,
            captureTrigger: 'manual',
            policyVersion: prefs.consent.policyVersion,
            digestText: serializeDigestPayload(payload),
            authorizationId: run.authorizationId,
            consentRevision: run.consentRevision,
            projectRoots,
        },
    });
    // Advancing lastCapturedSequence at enqueue is deliberate (concurrent hooks
    // cannot queue a slice twice), so a slice with no new activity is reported
    // from its own queue item, found by the slice's digest ID.
    let digestId;
    let item;
    let earlier;
    if ((ledger.lastCapturedSequence ?? 0) < sliceSequence) {
        let reserved = await reserveSlice();
        if (reserved.kind === 'queue_full') {
            // Resending the waiting manual items is what frees room for this slice.
            earlier = await retryEarlierManualItems(run);
            if (earlier.delivered > 0)
                reserved = await reserveSlice();
            if (reserved.kind === 'queue_full') {
                return {
                    exitCode: CLI_EXIT_CODES.GENERAL_ERROR,
                    data: {
                        captured: false,
                        alreadyDelivered: false,
                        requestsSent: earlier.requests,
                        retriedEarlier: earlier.retried,
                        earlierOutcomes: { delivered: earlier.delivered, failed: earlier.failed, stillQueued: earlier.stillQueued },
                        queueBusy: earlier.queueBusy,
                        message: queueFullMessage(run, earlier),
                    },
                };
            }
        }
        if (reserved.kind === 'already_captured') {
            // A lifecycle hook reserved this slice between the ledger read and the lock.
            digestId = sliceDigestId(reserved.capturedThroughSequence);
            item = findQueueItem(run.baseDir, digestId);
        }
        else {
            digestId = reserved.item.digestId;
            item = reserved.item;
        }
    }
    else {
        digestId = sliceDigestId(ledger.lastCapturedSequence ?? 0);
        item = findQueueItem(run.baseDir, digestId);
    }
    const requeuedAutomatic = await requeueOnce();
    if (requeuedAutomatic > 0 && item)
        item = findQueueItem(run.baseDir, digestId);
    const outcome = await settleSlice(run, item);
    earlier ??= outcome.retryEarlier
        ? await retryEarlierManualItems(run, digestId)
        : { waiting: 0, retried: 0, delivered: 0, failed: 0, stillQueued: 0, requests: 0, queueBusy: false };
    const after = findQueueItem(run.baseDir, digestId);
    const failureClass = after ? queueItemFailureClass(after) : undefined;
    return {
        exitCode: outcome.exitCode,
        data: {
            captured: outcome.captured,
            alreadyDelivered: Boolean(outcome.alreadyDelivered),
            // Digest requests this run actually sent, for this slice and earlier items.
            requestsSent: (outcome.flushed?.requests ?? 0) + earlier.requests,
            digestId,
            status: after?.status ?? null,
            ...(failureClass ? { failureClass } : {}),
            failed: outcome.flushed?.failed ?? 0,
            unknown: outcome.flushed?.unknown ?? 0,
            queueBusy: Boolean(outcome.flushed?.queueBusy || earlier.queueBusy),
            retriedEarlier: earlier.retried,
            ...(requeuedAutomatic > 0 ? { requeuedAutomatic } : {}),
            ...(earlier.waiting > 0
                ? { earlierOutcomes: { delivered: earlier.delivered, failed: earlier.failed, stillQueued: earlier.stillQueued } }
                : {}),
            ...(outcome.payload !== undefined ? { payload: outcome.payload } : {}),
            message: outcome.message + earlierSummary(earlier) + requeuedMessage(requeuedAutomatic),
        },
    };
}
export function capturePurgeLocal(options) {
    const preview = previewCapturePurge(options?.baseDir);
    const removed = purgeCaptureLocalState(options?.baseDir);
    return {
        exitCode: CLI_EXIT_CODES.SUCCESS,
        data: {
            preview,
            removed,
            message: 'BrainMCP-owned local queue, session-ledger, and orientation-cache files purged. Credentials, preferences, and host configuration were preserved.',
        },
    };
}
export function capturePurgePreview(options) {
    return previewCapturePurge(options?.baseDir);
}
//# sourceMappingURL=capture.js.map