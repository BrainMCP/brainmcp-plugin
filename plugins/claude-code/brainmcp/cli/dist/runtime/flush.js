import { normalizeCaptureTrigger } from '../agent-config.js';
import { apiPathSegment } from '../api-client.js';
import { listQueueItems, updateQueueItem, getQueueDir } from './queue.js';
import { logRuntimeEvent } from './diagnostics.js';
import { readPreferences, readSafeJson, resolveStateDir, writeAtomic0600 } from './storage.js';
import { SessionLockTimeoutError, withSessionLock } from './lock.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const MAX_CAPTURE_QUEUE_ITEMS = 50;
export const MAX_CAPTURE_QUEUE_BYTES = 10 * 1024 * 1024;
export const MAX_CAPTURE_ATTEMPTS = 8;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000];
export function classifyCaptureFailure(status, message, code) {
    if (status === 401 || /unauthorized|invalid_token|auth_required/i.test(message ?? '')) {
        return 'auth_required';
    }
    if (status === 403 || /missing required MCP OAuth scope/i.test(message ?? '')) {
        return 'terminal';
    }
    // The workspace's pending-digest cap clears once an agent processes digests.
    if (status === 409 && code === 'pending_digest_cap_reached') {
        return 'retryable';
    }
    if (status === 400 || (status !== null && status >= 400 && status < 500 && status !== 429)) {
        return 'non_retryable';
    }
    if (status === 429 || (status !== null && status >= 500) || status === null) {
        return 'retryable';
    }
    return 'retryable';
}
/**
 * Why a `failed` item failed. 0.1.29+ flushes record `failureClass`; items failed
 * by older runtimes keep only `lastError` (content-free: an HTTP status or a fixed
 * message) and `attempts`, so the class is derived from those.
 */
export function queueItemFailureClass(item) {
    if (item.status !== 'failed')
        return undefined;
    if (item.failureClass)
        return item.failureClass;
    const lastError = item.lastError ?? '';
    // CompanionReauthRequiredError carries status 401 but no status in its message.
    if (/sign-in expired or was revoked/i.test(lastError))
        return 'auth_required';
    const status = Number(lastError.match(/status (\d{3})/i)?.[1]) || null;
    const klass = classifyCaptureFailure(status, lastError);
    if (klass !== 'retryable')
        return klass;
    return item.attempts >= MAX_CAPTURE_ATTEMPTS ? 'retry_exhausted' : 'non_retryable';
}
export function getCaptureStatusPath(baseDir) {
    return path.join(resolveStateDir(baseDir), 'capture-status.json');
}
function validateCaptureStatusRecord(data) {
    const obj = data && typeof data === 'object' ? data : {};
    if (obj.version !== 1 || typeof obj.lastSuccessfulDeliveryAt !== 'string' ||
        !Number.isFinite(Date.parse(obj.lastSuccessfulDeliveryAt))) {
        throw new Error('Unsupported capture status record');
    }
    return { version: 1, lastSuccessfulDeliveryAt: obj.lastSuccessfulDeliveryAt };
}
/** The recorded last delivery, or null when none is recorded or the file is unusable. */
export function readCaptureStatus(baseDir) {
    try {
        return readSafeJson(getCaptureStatusPath(baseDir), validateCaptureStatusRecord);
    }
    catch {
        return null;
    }
}
/**
 * Record an accepted delivery, keeping the later timestamp. Callers hold the
 * capture-queue lock. A failed write is logged and never fails the delivery.
 */
function recordCaptureDelivery(deliveredAt, baseDir) {
    try {
        const current = readCaptureStatus(baseDir);
        if (current && Date.parse(current.lastSuccessfulDeliveryAt) >= Date.parse(deliveredAt))
            return;
        const record = { version: 1, lastSuccessfulDeliveryAt: deliveredAt };
        writeAtomic0600(getCaptureStatusPath(baseDir), JSON.stringify(record, null, 2));
    }
    catch (error) {
        // The errno class only: messages name local paths.
        const errno = error?.code;
        logRuntimeEvent('warn', 'capture_status_write_failed', { errno: typeof errno === 'string' ? errno : 'unknown' }, baseDir);
    }
}
export function nextRetryAt(attempts, now = Date.now(), jitterMs = Math.floor(Math.random() * 500)) {
    const base = BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1] ?? 32_000;
    return new Date(now + base + jitterMs).toISOString();
}
export function queueByteSize(baseDir) {
    const dir = getQueueDir(baseDir);
    let total = 0;
    for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.json'))
            continue;
        try {
            total += fs.statSync(path.join(dir, entry)).size;
        }
        catch {
            // ignore
        }
    }
    return total;
}
export function canEnqueueCapture(baseDir) {
    const items = listQueueItems(baseDir).filter((item) => item.status === 'pending' || item.status === 'sending' || item.status === 'delivery_unknown');
    if (items.length >= MAX_CAPTURE_QUEUE_ITEMS)
        return false;
    return queueByteSize(baseDir) < MAX_CAPTURE_QUEUE_BYTES;
}
const CAPTURE_QUEUE_LOCK_TIMEOUT_MS = 250;
const DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS = 5_000;
/** A delivery lease outlives its request by this much, so no other run takes the item over mid-request. */
const DELIVERY_LEASE_HEADROOM_MS = 5_000;
async function postDigest(apiClient, item, signal, beforeSend, timeoutMs) {
    try {
        await apiClient.request(`/api/workspaces/${apiPathSegment(item.workspaceId)}/digests`, {
            method: 'POST',
            body: {
                clientDigestId: item.digestId,
                trigger: normalizeCaptureTrigger(item.captureTrigger),
                capturePolicyVersion: item.policyVersion,
                digestText: item.digestText.trim() || 'Session capture with no assistant summary.',
                source: 'mcp_tool',
            },
            signal,
            expectedAuthorizationId: item.authorizationId,
            beforeSend,
            timeoutMs,
        });
        return { ok: true, status: 200 };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusFromError = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
            ? error.status
            : null;
        const statusMatch = message.match(/status (\d{3})/i);
        const status = statusFromError ?? (statusMatch ? Number(statusMatch[1]) : null);
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined;
        return { ok: false, status, message, code };
    }
}
export async function flushCaptureQueue(options) {
    // Pin this run to one physical account namespace, including completion after
    // another process switches the active account.
    options = { ...options, baseDir: resolveStateDir(options.baseDir) };
    const result = { sent: 0, failed: 0, skipped: 0, unknown: 0, requests: 0 };
    const now = options.now ?? Date.now();
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CAPTURE_REQUEST_TIMEOUT_MS;
    const items = listQueueItems(options.baseDir);
    const credentials = options.credentials === undefined
        ? await options.apiClient.getEffectiveCredentials()
        : options.credentials;
    for (const item of items) {
        if (options.signal?.aborted)
            break;
        if (options.digestId && item.digestId !== options.digestId)
            continue;
        if (options.digestIds && !options.digestIds.includes(item.digestId))
            continue;
        if (item.status === 'delivered' || item.status === 'cancelled' || item.status === 'failed') {
            result.skipped += 1;
            continue;
        }
        if (item.nextRetryAt && Date.parse(item.nextRetryAt) > now) {
            result.skipped += 1;
            continue;
        }
        if (!options.includeManual && item.captureTrigger === 'manual') {
            // Manual items are sent by `capture now`, not background hooks.
            continue;
        }
        const isAutomatic = item.captureTrigger !== 'manual';
        const consentStillMatches = () => {
            const prefs = readPreferences(options.baseDir);
            return prefs?.consent?.captureEnabled === true &&
                (!isAutomatic || options.allowAutomatic === true) &&
                item.consentRevision !== undefined && item.consentRevision === (prefs.consent.revision ?? 0) &&
                (!isAutomatic || item.workspaceId === prefs.enabledWorkspaceId);
        };
        if (isAutomatic) {
            if (!consentStillMatches()) {
                if (item.status === 'pending') {
                    updateQueueItem(item.digestId, { status: 'cancelled', lastError: 'Capture consent or project policy changed before delivery' }, options.baseDir);
                }
                result.skipped += 1;
                continue;
            }
        }
        const currentAuthorizationId = credentials?.authType === 'oauth' ? credentials.authorizationId : undefined;
        if (!item.authorizationId || !currentAuthorizationId || item.authorizationId !== currentAuthorizationId) {
            updateQueueItem(item.digestId, { status: 'cancelled', lastError: 'Capture item belongs to a different or unknown authorization' }, options.baseDir);
            result.skipped += 1;
            continue;
        }
        if (!credentials?.scopes?.includes('digests:write') || !credentials.workspaces?.includes(item.workspaceId)) {
            result.skipped += 1;
            continue;
        }
        const owner = randomUUID();
        let claimed;
        // Status before this claim. A `sending` item whose lease expired was cut off
        // mid-request by an earlier run, so its outcome is unknown.
        let statusBeforeClaim = item.status;
        try {
            claimed = await withSessionLock('capture-queue', () => {
                const current = listQueueItems(options.baseDir).find((queued) => queued.digestId === item.digestId);
                if (!current || ['delivered', 'cancelled', 'failed'].includes(current.status) ||
                    (current.deliveryLease && Date.parse(current.deliveryLease.expiresAt) > Date.now()) ||
                    (current.nextRetryAt && Date.parse(current.nextRetryAt) > now) ||
                    !consentStillMatches() || options.signal?.aborted)
                    return null;
                statusBeforeClaim = current.status === 'sending' ? 'delivery_unknown' : current.status;
                return updateQueueItem(item.digestId, { status: 'sending', deliveryLease: { owner,
                        expiresAt: new Date(Date.now() + requestTimeoutMs + DELIVERY_LEASE_HEADROOM_MS).toISOString() } }, options.baseDir);
            }, { baseDir: options.baseDir, timeoutMs: CAPTURE_QUEUE_LOCK_TIMEOUT_MS });
        }
        catch (error) {
            if (!(error instanceof SessionLockTimeoutError))
                throw error;
            // Another flush owns the queue right now; it will deliver or reschedule these items.
            result.queueBusy = true;
            logRuntimeEvent('info', 'capture_flush_queue_busy', { digestId: item.digestId, waitedMs: error.waitedMs }, options.baseDir);
            break;
        }
        if (!claimed) {
            result.skipped += 1;
            continue;
        }
        // Local bookkeeping after the request. A failure here must not turn the
        // delivery outcome into an error: the lease expires and the item is retried.
        const finish = async (updates) => {
            try {
                await withSessionLock('capture-queue', () => {
                    // The server accepted the digest even if another run took this item over since.
                    if (updates.status === 'delivered' && updates.deliveredAt)
                        recordCaptureDelivery(updates.deliveredAt, options.baseDir);
                    const current = listQueueItems(options.baseDir).find((queued) => queued.digestId === item.digestId);
                    if (current?.deliveryLease?.owner !== owner)
                        return;
                    updateQueueItem(item.digestId, { ...updates, deliveryLease: undefined }, options.baseDir);
                }, { baseDir: options.baseDir, timeoutMs: CAPTURE_QUEUE_LOCK_TIMEOUT_MS });
            }
            catch (error) {
                result.bookkeepingErrors = (result.bookkeepingErrors ?? 0) + 1;
                logRuntimeEvent('warn', 'capture_flush_bookkeeping_failed', {
                    digestId: item.digestId,
                    status: updates.status,
                    error: error instanceof Error ? error.message : String(error),
                }, options.baseDir);
            }
        };
        let handedToNetwork = false;
        const response = await postDigest(options.apiClient, claimed, options.signal, () => {
            if (!consentStillMatches())
                return false;
            result.requests += 1;
            handedToNetwork = true;
            return true;
        }, requestTimeoutMs);
        if (response.ok) {
            await finish({ status: 'delivered', deliveredAt: new Date().toISOString(), lastError: undefined, nextRetryAt: undefined });
            result.sent += 1;
            continue;
        }
        // The caller's own deadline (a hook budget or the background run ending) is
        // not a delivery failure: it spends no attempt. An item that was never sent
        // keeps its earlier status; a sent one may have reached the server.
        if (response.status === null && options.signal?.aborted) {
            await finish({ status: handedToNetwork ? 'delivery_unknown' : statusBeforeClaim });
            if (handedToNetwork)
                result.unknown += 1;
            else
                result.skipped += 1;
            break;
        }
        // The server already holds a digest with this id from another authorization.
        // The id hashes this sign-in's own session slice (`sessionSliceDigestId`),
        // so when an earlier attempt of ours may have reached the server, the held
        // digest is this one, stored before the grant's authorization id changed:
        // it is delivered, not failed. On a first attempt it is a real collision.
        if (response.status === 409 && response.code === 'digest_id_conflict' &&
            (statusBeforeClaim === 'delivery_unknown' || claimed.attempts > 0)) {
            await finish({ status: 'delivered', deliveredAt: new Date().toISOString(), lastError: undefined, nextRetryAt: undefined });
            logRuntimeEvent('info', 'capture_already_held', { digestId: claimed.digestId, code: response.code }, options.baseDir);
            result.sent += 1;
            continue;
        }
        const klass = classifyCaptureFailure(response.status, response.message, response.code);
        result.lastFailureClass = klass;
        if (klass === 'auth_required' || klass === 'terminal' || klass === 'non_retryable') {
            await finish({ status: 'failed', failureClass: klass, lastError: response.message ?? 'non-retryable capture failure', attempts: claimed.attempts + 1 });
            result.failed += 1;
            continue;
        }
        const attempts = claimed.attempts + 1;
        if (attempts >= MAX_CAPTURE_ATTEMPTS) {
            await finish({ status: 'failed', failureClass: 'retry_exhausted', attempts, lastError: response.message ?? 'retry limit reached' });
            result.failed += 1;
            continue;
        }
        // Only a request that reached the network can have an unknown outcome.
        const unknown = response.status === null && handedToNetwork;
        await finish({
            status: unknown ? 'delivery_unknown' : 'pending',
            attempts,
            // Back off from when this attempt ended: a slow request must not leave the retry already due.
            nextRetryAt: nextRetryAt(attempts, options.now ?? Date.now()),
            lastError: response.message,
        });
        if (unknown)
            result.unknown += 1;
        else
            result.failed += 1;
    }
    logRuntimeEvent('info', 'capture_flush', { ...result }, options.baseDir);
    return result;
}
//# sourceMappingURL=flush.js.map