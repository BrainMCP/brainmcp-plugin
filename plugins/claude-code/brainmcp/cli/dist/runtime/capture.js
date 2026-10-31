import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CAPTURE_POLICY_VERSION, scrubDigestSecrets } from '../agent-config.js';
import { MAX_QUEUE_PROJECT_ROOT_CHARS, MAX_QUEUE_PROJECT_ROOTS, PREFERENCES_SCHEMA_VERSION, isWorkspaceUuid, scrubSecrets, truncateCodePoints, MAX_ASSISTANT_SUMMARY_CHARS, } from '../lib/cli-contracts.js';
import { readPreferences, writePreferences } from './storage.js';
import { listQueueItems, updateQueueItem } from './queue.js';
import { logRuntimeEvent } from './diagnostics.js';
import { bindingWalkStart, isTrustedProjectPolicyFile, readProjectWorkspaceId } from './orient.js';
/**
 * Server digest caps, copied from `MCP_SESSION_DIGEST_MAX_CHARS` and
 * `MCP_SESSION_DIGEST_MAX_BYTES` (packages/types/src/mcp-subscription-limits.ts);
 * capture.test.ts fails when a copy drifts. The API applies both caps to the
 * trimmed digest text, then again after its own secret redaction
 * (packages/api/src/session-digests.ts), and answers an oversize digest with a
 * 400 the flush treats as non-retryable, so the digest would be lost.
 */
export const MAX_DIGEST_CHARS = 14_000;
export const MAX_DIGEST_BYTES = 14 * 1024;
/**
 * The text the server will store: the API's `scrubDigestText`
 * (packages/api/src/session-digests.ts) runs the same shared
 * `scrubDigestSecrets`, as capture.test.ts checks. Used only to measure that
 * text: the server redacts the serialized JSON, where escapes can complete a
 * match the field-level `scrubSecrets` did not see, and some markers are longer
 * than what they replace, so a digest under the caps can exceed them after
 * redaction. It never rewrites the payload.
 */
export function serverDigestRedactionPreview(value) {
    return scrubDigestSecrets(value);
}
/**
 * Why the server would reject this digest text for size, or null when it fits.
 * Lengths are UTF-16 code units, as the API's `.length` checks count them.
 */
export function digestTextLimitViolation(text) {
    const trimmed = text.trim();
    for (const [candidate, qualifier] of [[trimmed, ''], [serverDigestRedactionPreview(trimmed), ' after server redaction']]) {
        if (candidate.length > MAX_DIGEST_CHARS) {
            return `Digest payload exceeds max character cap${qualifier}: ${candidate.length} > ${MAX_DIGEST_CHARS}`;
        }
        const bytes = Buffer.byteLength(candidate, 'utf8');
        if (bytes > MAX_DIGEST_BYTES) {
            return `Digest payload exceeds max byte cap${qualifier}: ${bytes} > ${MAX_DIGEST_BYTES}`;
        }
    }
    return null;
}
/** How far the text is over the tightest server cap, in characters or bytes (0 when it fits). */
function digestTextOverflow(text) {
    const trimmed = text.trim();
    let overflow = 0;
    for (const candidate of [trimmed, serverDigestRedactionPreview(trimmed)]) {
        overflow = Math.max(overflow, candidate.length - MAX_DIGEST_CHARS, Buffer.byteLength(candidate, 'utf8') - MAX_DIGEST_BYTES);
    }
    return overflow;
}
const STOP_EVENTS = new Set(['Stop', 'StopNudge', 'stop', 'SessionStop', 'session_stop']);
const CAPTURE_EVENTS = new Set([
    'PreCompact',
    'preCompact',
    'pre_compact',
    'precompact',
    'SessionEnd',
    'sessionEnd',
    'session_end',
    'manual',
]);
export function isStopEvent(event, stopHookActive) {
    return stopHookActive === true || STOP_EVENTS.has(event);
}
export function captureTriggerForEvent(event) {
    if (event === 'SessionEnd' || event === 'sessionEnd' || event === 'session_end')
        return 'session_end';
    if (event === 'PreCompact' || event === 'preCompact' || event === 'pre_compact' || event === 'precompact') {
        return 'pre_compact';
    }
    if (event === 'manual')
        return 'manual';
    return null;
}
/**
 * Project `.brainmcp.json` may disable or further restrict capture; it can
 * never enable capture or broaden captured fields (AHI-D02).
 */
export function readProjectCaptureRestrictions(startDir) {
    const result = { captureDisabled: false, promptsDisabled: false };
    if (!startDir)
        return result;
    // The same real-path start as the workspace binding walk, so a symlinked
    // root cannot pick up the binding while skipping the opt-out beside it.
    let dir = bindingWalkStart(startDir);
    for (let i = 0; i < 16; i += 1) {
        const candidate = path.join(dir, '.brainmcp.json');
        const found = fs.lstatSync(candidate, { throwIfNoEntry: false });
        // Another account's file in a world-writable directory is skipped, as the binding walk does.
        if (found && isTrustedProjectPolicyFile(dir, found)) {
            try {
                const stat = fs.lstatSync(candidate);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024)
                    return { captureDisabled: true, promptsDisabled: true };
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    return { captureDisabled: true, promptsDisabled: true };
                const consent = parsed.consent && typeof parsed.consent === 'object'
                    ? parsed.consent
                    : undefined;
                if (parsed.capture === false ||
                    parsed.captureEnabled === false ||
                    consent?.captureEnabled === false) {
                    result.captureDisabled = true;
                }
                if (parsed.includePrompts === false || consent?.includePrompts === false) {
                    result.promptsDisabled = true;
                }
            }
            catch {
                return { captureDisabled: true, promptsDisabled: true };
            }
            return result;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return result;
}
export function resolveCaptureWorkspaceId(prefs) {
    const candidate = prefs?.enabledWorkspaceId?.trim();
    if (candidate && isWorkspaceUuid(candidate))
        return candidate;
    return null;
}
/** An opaque project boundary for selecting a manual session without storing paths. */
export function captureProjectKey(cwd) {
    let dir = fs.realpathSync(path.resolve(cwd));
    const original = dir;
    for (let i = 0; i < 32; i += 1) {
        if (fs.existsSync(path.join(dir, '.git')) || fs.lstatSync(path.join(dir, '.brainmcp.json'), { throwIfNoEntry: false }))
            break;
        const parent = path.dirname(dir);
        if (parent === dir) {
            dir = original;
            break;
        }
        dir = parent;
    }
    return crypto.createHash('sha256').update(dir).digest('hex');
}
/**
 * `captureProjectKey`, or undefined when it cannot be computed (the cwd was
 * deleted or is unreadable), so the hook leaves the key the ledger recorded
 * while the directory existed. Never approximated: `path.resolve` skips the
 * realpath (`/var` vs `/private/var` on macOS) and the nearest existing
 * ancestor can be a parent repository, and either would re-key the session.
 * `capture now` keeps the strict version so its project filter fails closed.
 */
export function tryCaptureProjectKey(cwd) {
    try {
        return captureProjectKey(cwd);
    }
    catch {
        return undefined;
    }
}
/**
 * Git limits per capture trigger. `execFileSync` blocks the event loop, so no
 * dispatch timer or process deadline can interrupt a Git call; the totals keep
 * a hook inside its host deadline. PreCompact shares its 1000 ms dispatch with
 * the queue flush that follows. SessionEnd has 2000 ms and no flush (Codex
 * stops it at 3 s), or 700 ms under Claude Code, whose shared SessionEnd budget
 * is 1.5 s. Hooks also pass `deadlineAt`, so Git never runs past the
 * dispatch deadline whatever ran before it. Manual `capture now` has no host
 * deadline, so large working trees get up to 2 s per stats call.
 */
export const GIT_METADATA_BUDGETS = {
    pre_compact: { labelTimeoutMs: 100, statsTimeoutMs: 150, totalMs: 400 },
    session_end: { labelTimeoutMs: 125, statsTimeoutMs: 400, totalMs: 1_000 },
    manual: { labelTimeoutMs: 250, statsTimeoutMs: 2_000, totalMs: 4_000 },
};
/** With less time left than this, a Git call is skipped and reported as timed out. */
const MIN_GIT_CALL_MS = 20;
/** The same guard as the backups' Git check (lib/backups.ts): no fsmonitor, no hooks. */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', ...(process.platform === 'win32' ? [] : ['-c', 'core.hooksPath=/dev/null'])];
/** The process environment without the variables that point Git at another repository. */
function gitEnvironment() {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'])
        delete env[key];
    return env;
}
/**
 * Read only bounded Git labels/counts; never persist the repository root or changed paths.
 * When `diff` or `status` fails or times out, `diffStats` is omitted rather than
 * reported as zeros, which would read as a clean tree.
 */
export function collectGitMetadata(cwd, options) {
    if (!cwd)
        return undefined;
    const budget = GIT_METADATA_BUDGETS[options.trigger];
    const stopAt = Math.min(Date.now() + budget.totalMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
    // A hook must not take `index.lock`: a git command the user runs at the same
    // moment would fail. `status` refreshes the index under it unless
    // `--no-optional-locks` is given; `git diff` does even then, so the diff
    // counts come from the plumbing `diff-index`, which never writes the index.
    // Hooks run this in whatever repository the agent is in, so a repository's
    // `core.fsmonitor` and hooks are turned off (fsmonitor runs on `status` and
    // `diff-index`), and an inherited GIT_DIR must not answer for it. A filter
    // driver (`filter.*.clean` with `.gitattributes`) can still run, as in the
    // backups' Git check: the guard narrows what repository config can start.
    const run = options.runner ?? ((args, timeoutMs) => execFileSync('git', [...GIT_SAFE_CONFIG, '--no-optional-locks', '-C', cwd, ...args], {
        encoding: 'utf8',
        env: gitEnvironment(),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const read = (args, capMs) => {
        const timeoutMs = Math.floor(Math.min(capMs, stopAt - Date.now()));
        if (timeoutMs < MIN_GIT_CALL_MS)
            return { failure: 'timeout' };
        try {
            return { output: run(args, timeoutMs).trim() };
        }
        catch (error) {
            return { failure: error?.code === 'ETIMEDOUT' ? 'timeout' : 'error' };
        }
    };
    // Step names and failure classes only: Git's error text names the repository path.
    const failures = {};
    const reportFailures = () => {
        if (Object.keys(failures).length === 0)
            return;
        logRuntimeEvent('warn', 'capture_git_metadata_incomplete', { trigger: options.trigger, ...failures }, options.baseDir);
    };
    const outputOf = (step, result) => {
        if ('output' in result)
            return result.output;
        failures[step] = result.failure;
        return undefined;
    };
    const top = read(['rev-parse', '--show-toplevel'], budget.labelTimeoutMs);
    if (!('output' in top) || !top.output) {
        // Outside a repository this fails by design; only a timeout is worth reporting.
        if ('failure' in top && top.failure === 'timeout')
            failures.toplevel = 'timeout';
        reportFailures();
        return undefined;
    }
    const branch = outputOf('branch', read(['branch', '--show-current'], budget.labelTimeoutMs));
    const commit = outputOf('commit', read(['rev-parse', '--short=12', 'HEAD'], budget.labelTimeoutMs));
    const numstat = outputOf('diff', read(['diff-index', '--numstat', 'HEAD'], budget.statsTimeoutMs));
    const changedFiles = outputOf('status', read(['status', '--porcelain=v1', '--untracked-files=no'], budget.statsTimeoutMs));
    reportFailures();
    const metadata = {
        repository: path.basename(top.output),
        branch: branch || undefined,
        commit: commit || undefined,
    };
    if (numstat !== undefined && changedFiles !== undefined) {
        let insertions = 0;
        let deletions = 0;
        for (const line of numstat.split('\n')) {
            if (!line)
                continue;
            const [added, removed] = line.split('\t');
            if (/^\d+$/.test(added ?? ''))
                insertions += Number(added);
            if (/^\d+$/.test(removed ?? ''))
                deletions += Number(removed);
        }
        const filesChanged = changedFiles ? changedFiles.split('\n').filter(Boolean).length : 0;
        metadata.diffStats = { filesChanged, insertions, deletions };
    }
    return metadata;
}
/** Code points of digest summary a capture sends at most ("at most 4,000 characters per digest"). */
const MAX_SUMMARY_CHARS = MAX_ASSISTANT_SUMMARY_CHARS;
function truncateUtf8(value, maxBytes) {
    let output = '';
    let bytes = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > maxBytes)
            break;
        output += character;
        bytes += characterBytes;
    }
    return output;
}
/**
 * The longest code-point prefix of the summary that keeps the digest within the
 * server caps, or undefined when none does. Escapes and redaction make the size
 * of a prefix hard to predict, so this binary-searches the prefix length; every
 * candidate ends on a code-point boundary and stays valid UTF-8.
 */
function longestFittingSummary(payload, summary) {
    const codePoints = Array.from(summary);
    const prefix = (length) => (length > 0 ? codePoints.slice(0, length).join('') : undefined);
    const fits = (length) => digestTextOverflow(JSON.stringify({ ...payload, summary: prefix(length) })) <= 0;
    let low = 0;
    let high = codePoints.length;
    if (fits(high))
        return summary;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (fits(middle))
            low = middle;
        else
            high = middle;
    }
    return prefix(low);
}
/**
 * Normalizes and filters capture payload fields (AHI-073, AHI-074, AHI-075).
 * Drops absolute/traversal paths, raw file contents, secrets, and prompts (unless opt-in enabled).
 * The ledger keeps prompts and paths oldest first and is not reset by a capture,
 * so the digest keeps the newest ones and drops the oldest first to fit: a later
 * capture in the same session then carries its own recent work.
 */
export function buildDigestPayload(input) {
    const clientDigestId = crypto.randomUUID();
    // Filter paths: relative only, no traversal (../), no absolute
    const safePaths = [];
    if (input.paths) {
        for (const p of input.paths) {
            if (typeof p !== 'string')
                continue;
            const normalized = path.normalize(p.trim());
            if (path.isAbsolute(normalized))
                continue;
            if (normalized.startsWith('..') || normalized.includes('../') || normalized.includes('..\\'))
                continue;
            safePaths.push(truncateUtf8(scrubSecrets(normalized), 180));
        }
    }
    // Include prompts only if explicitly opted in
    const safePrompts = [];
    if (input.includePrompts && input.prompts) {
        for (const pr of input.prompts) {
            if (typeof pr === 'string' && pr.trim()) {
                safePrompts.push(truncateUtf8(scrubSecrets(pr), 800));
            }
        }
    }
    const payload = {
        clientDigestId,
        trigger: input.trigger,
        workspaceId: input.workspaceId,
        host: input.host ? truncateUtf8(scrubSecrets(input.host), 80) : undefined,
        model: input.model ? truncateUtf8(scrubSecrets(input.model), 120) : undefined,
        // Characters, as the capture disclosure states: a byte cut dropped the
        // newest turn of a non-ASCII summary. The server caps are enforced below.
        summary: input.summary ? truncateCodePoints(scrubSecrets(input.summary), MAX_SUMMARY_CHARS) : undefined,
        relativePaths: safePaths.slice(-50),
        gitMetadata: input.gitMetadata
            ? {
                branch: input.gitMetadata.branch
                    ? truncateUtf8(scrubSecrets(input.gitMetadata.branch), 180)
                    : undefined,
                commit: input.gitMetadata.commit
                    ? truncateUtf8(scrubSecrets(input.gitMetadata.commit), 180)
                    : undefined,
                repository: input.gitMetadata.repository
                    ? truncateUtf8(scrubSecrets(input.gitMetadata.repository), 180)
                    : undefined,
                diffStats: input.gitMetadata.diffStats
                    ? {
                        filesChanged: Math.max(0, Math.min(100_000, Math.trunc(input.gitMetadata.diffStats.filesChanged))),
                        insertions: Math.max(0, Math.min(10_000_000, Math.trunc(input.gitMetadata.diffStats.insertions))),
                        deletions: Math.max(0, Math.min(10_000_000, Math.trunc(input.gitMetadata.diffStats.deletions))),
                    }
                    : undefined,
            }
            : undefined,
        prompts: safePrompts.length > 0 ? safePrompts.slice(-10) : undefined,
    };
    // JSON escaping, multibyte text, and server redaction markers grow the text
    // independently of the per-field limits, so measure the serialized digest
    // against both server caps, before and after the server's redaction.
    while (digestTextOverflow(JSON.stringify(payload)) > 0) {
        if (payload.prompts?.length) {
            payload.prompts.shift();
            if (payload.prompts.length === 0)
                payload.prompts = undefined;
            continue;
        }
        if (payload.relativePaths?.length) {
            payload.relativePaths.shift();
            if (payload.relativePaths.length === 0)
                payload.relativePaths = undefined;
            continue;
        }
        if (payload.summary) {
            payload.summary = longestFittingSummary(payload, payload.summary);
            continue;
        }
        payload.gitMetadata = undefined;
        break;
    }
    return payload;
}
/**
 * Serializes payload to JSON and verifies the server will accept its size,
 * before and after server-side redaction (see `digestTextLimitViolation`).
 */
export function serializeDigestPayload(payload) {
    const json = JSON.stringify(payload);
    const violation = digestTextLimitViolation(json);
    if (violation)
        throw new Error(violation);
    return json;
}
/**
 * What digest capture uploads, shown before consent (`login --capture-digests`,
 * `capture enable`). Change it together with CAPTURE_POLICY_VERSION: consent
 * recorded under another version pauses capture until the user accepts again.
 * Through 0.1.37 it said assistant text was a "stable summary"; since 0.1.38
 * Claude Code and Codex capture reads the closing replies from the host
 * transcript (TRANSCRIPT_SUMMARY_MAX_TURNS × TRANSCRIPT_SUMMARY_TURN_MAX_CHARS).
 */
export const CAPTURE_DISCLOSURE = 'Digest capture uploads to Brain: host and model labels; Git metadata (branch, commit, repository, diff counts); relative edited paths; ' +
    "and the assistant's own replies: for Claude Code and Codex, the closing assistant message of each of the latest 3 turns " +
    '(up to 1,500 characters each, at most 4,000 characters per digest), which can repeat code, file contents, or tool output the assistant quoted. ' +
    'Secret-like strings are scrubbed first. Your prompts are excluded unless you opt in with --include-prompts; raw transcripts, files read from disk, ' +
    'tool payloads, and environment variables are not uploaded. Disable with `brainmcp capture disable`.';
/** How to accept the current capture policy after it changed. */
export const CAPTURE_RECONSENT_COMMAND = 'brainmcp capture enable';
/**
 * The re-consent command for these preferences. `capture enable` records a new
 * consent with prompts off unless `--include-prompts` is passed, so a user who
 * had opted in to prompts is told to pass it again.
 */
export function captureReconsentCommand(prefs) {
    return prefs?.consent?.includePrompts ? `${CAPTURE_RECONSENT_COMMAND} --include-prompts` : CAPTURE_RECONSENT_COMMAND;
}
/** Capture is on and its consent was given to the current policy version. */
export function captureConsentActive(prefs) {
    return prefs?.consent?.captureEnabled === true && prefs.consent.policyVersion === CAPTURE_POLICY_VERSION;
}
/**
 * Capture is on, but its consent was given to an earlier policy version: it
 * is paused (nothing is recorded, queued, or sent) until the user accepts the
 * current policy with `brainmcp capture enable`.
 */
export function captureConsentOutdated(prefs) {
    return prefs?.consent?.captureEnabled === true && prefs.consent.policyVersion !== CAPTURE_POLICY_VERSION;
}
/**
 * Enables capture for the user (AHI-071, AHI-072).
 */
export function enableCapture(options) {
    const current = readPreferences(options?.baseDir) ?? {
        version: PREFERENCES_SCHEMA_VERSION,
        consent: {
            captureEnabled: false,
            includePrompts: false,
            policyVersion: CAPTURE_POLICY_VERSION,
            revision: 0,
        },
    };
    const workspaceId = options?.workspaceId?.trim();
    const previousRevision = current.consent.revision ?? 0;
    // A disabled consent at a revision above 0 was written by a disable. One an
    // older CLI (0.1.38 and earlier) wrote carries no lastDisabledRevision, so it
    // is recorded here, before the revision moves past it.
    const lastDisabledRevision = !current.consent.captureEnabled && previousRevision > 0
        ? Math.max(current.consent.lastDisabledRevision ?? 0, previousRevision)
        : current.consent.lastDisabledRevision;
    const updated = {
        ...current,
        consent: {
            ...current.consent,
            ...(lastDisabledRevision !== undefined ? { lastDisabledRevision } : {}),
            captureEnabled: true,
            includePrompts: Boolean(options?.includePrompts),
            // Consent given now is to the current policy, even when an older one is on file.
            policyVersion: CAPTURE_POLICY_VERSION,
            consentedAt: new Date(options?.now ?? Date.now()).toISOString(),
            revision: (current.consent.revision ?? 0) + 1,
        },
        enabledWorkspaceId: workspaceId && isWorkspaceUuid(workspaceId) ? workspaceId : current.enabledWorkspaceId,
    };
    writePreferences(updated, options?.baseDir);
    return updated;
}
/**
 * Disables capture and atomically cancels all pending automatic queue items (AHI-071).
 * Re-enabling never resurrects cancelled items.
 */
export function disableCapture(options) {
    const current = readPreferences(options?.baseDir) ?? {
        version: PREFERENCES_SCHEMA_VERSION,
        consent: {
            captureEnabled: false,
            includePrompts: false,
            policyVersion: CAPTURE_POLICY_VERSION,
            revision: 0,
        },
    };
    const revision = (current.consent.revision ?? 0) + 1;
    const updated = {
        ...current,
        consent: {
            ...current.consent,
            captureEnabled: false,
            includePrompts: false,
            revision,
            // `capture now` never requeues an item queued at or before this revision.
            lastDisabledRevision: revision,
        },
    };
    writePreferences(updated, options?.baseDir);
    // Cancel only unsent automatic items, including ones that ran out of
    // retries: `capture now` requeues those across a later re-consent, which must
    // not resurrect what a disable withdrew (lastDisabledRevision also keeps it
    // from requeueing a failed item an older CLI's disable left behind). Manual
    // items remain explicit user actions, and ambiguous in-flight deliveries
    // retain their honest status.
    const items = listQueueItems(options?.baseDir);
    for (const item of items) {
        if (item.captureTrigger !== 'manual' && (item.status === 'pending' || item.status === 'failed')) {
            updateQueueItem(item.digestId, {
                status: 'cancelled',
                lastError: 'Capture disabled by user',
            }, options?.baseDir);
        }
    }
    return updated;
}
/**
 * Whether an automatic item queued under consent revision `itemRevision` may
 * be requeued (and re-stamped) under the current consent: never when a
 * disable may lie between the two, since that disable withdrew it.
 *
 * - Same revision: yes.
 * - With `lastDisabledRevision` on file (0.1.40+ disable, or recorded by the
 *   next enable after an older CLI's disable): only items queued after it. An
 *   older CLI's later write drops the field, so its presence means every
 *   disable since was recorded.
 * - Without it, a 0.1.38 or older CLI may have disabled and re-enabled with
 *   no record. Items are queued only while capture is enabled, and capture is
 *   enabled now, so exactly one revision between them is an enable (a
 *   re-consent); a larger gap may include a disable, so the item is skipped.
 */
export function consentRevisionAllowsRequeue(itemRevision, prefs) {
    const current = prefs.consent.revision ?? 0;
    if (itemRevision === undefined || !Number.isSafeInteger(itemRevision) || itemRevision > current)
        return false;
    if (itemRevision === current)
        return true;
    const lastDisabled = prefs.consent.lastDisabledRevision;
    if (lastDisabled !== undefined)
        return itemRevision > lastDisabled;
    return current - itemRevision === 1;
}
/**
 * Checks whether an event may be queued or sent (AHI-076).
 * Stop events MUST NEVER queue or send digests.
 */
export function isCaptureEligible(event, prefs, projectPolicy) {
    if (isStopEvent(event)) {
        return false;
    }
    if (projectPolicy?.captureDisabled) {
        return false;
    }
    // Consent to an earlier capture policy does not cover the current one.
    if (!captureConsentActive(prefs)) {
        return false;
    }
    return CAPTURE_EVENTS.has(event);
}
/**
 * The project roots a hook or `capture now` records on its queue item, so each
 * send can re-read their policy. Resolved and deduplicated; never sent.
 * Undefined when they do not all fit the queue item's bounds: a root left out
 * could not stop the digest later (an opt-out or a new binding there would go
 * unseen at send time), so the caller does not capture.
 */
export function queueProjectRoots(roots) {
    const resolved = [...new Set(roots.map((root) => path.resolve(root)))];
    return resolved.length <= MAX_QUEUE_PROJECT_ROOTS && resolved.every((root) => root.length <= MAX_QUEUE_PROJECT_ROOT_CHARS)
        ? resolved
        : undefined;
}
/**
 * Whether a queued digest carries prompt text. Every producer stores a
 * serialized `DigestPayload`; text that does not parse as one cannot be shown
 * to be prompt-free, so it counts as carrying prompts.
 */
export function queuedDigestCarriesPrompts(digestText) {
    if (!digestText.trim())
        return false;
    try {
        const parsed = JSON.parse(digestText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return true;
        const prompts = parsed.prompts;
        return prompts !== undefined && prompts !== null && !(Array.isArray(prompts) && prompts.length === 0);
    }
    catch {
        return true;
    }
}
/**
 * Whether the projects a queued item was captured in still allow sending it
 * to `workspaceId`: each root's nearest `.brainmcp.json` is re-read for an
 * opt-out, for a prompt opt-out when the digest carries prompts, and for a
 * binding to another (or no valid) workspace. An automatic item queued before
 * 0.1.38 records no roots and fails closed; such a manual item was an explicit
 * `capture now` and keeps its earlier behavior.
 */
export function queuedItemProjectAllowsCapture(item, workspaceId) {
    const roots = item.projectRoots;
    if (!roots)
        return item.captureTrigger === 'manual';
    const restrictions = roots.map((root) => readProjectCaptureRestrictions(root));
    if (restrictions.some((policy) => policy.captureDisabled))
        return false;
    // The prompts were allowed when the slice was queued; a project that has
    // since set `includePrompts: false` stops them on every send and retry.
    if (restrictions.some((policy) => policy.promptsDisabled) && queuedDigestCarriesPrompts(item.digestText))
        return false;
    return !projectBindingBlocksCapture(roots, workspaceId);
}
/** A capture cannot override the nearest project binding or an invalid policy file. */
export function projectBindingBlocksCapture(roots, workspaceId) {
    return captureProjectBindingConflict(roots, workspaceId) !== undefined;
}
export function captureProjectBindingConflict(roots, workspaceId) {
    for (const root of roots) {
        const binding = readProjectWorkspaceId(root);
        if (binding.kind === 'invalid' || (binding.kind === 'workspace' && binding.workspaceId !== workspaceId))
            return binding;
    }
    return undefined;
}
//# sourceMappingURL=capture.js.map