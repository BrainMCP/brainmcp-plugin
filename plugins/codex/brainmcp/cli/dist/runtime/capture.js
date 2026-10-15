import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CAPTURE_POLICY_VERSION, scrubDigestSecrets } from '../agent-config.js';
import { PREFERENCES_SCHEMA_VERSION, isWorkspaceUuid, scrubSecrets, } from '../lib/cli-contracts.js';
import { readPreferences, writePreferences } from './storage.js';
import { listQueueItems, updateQueueItem } from './queue.js';
import { logRuntimeEvent } from './diagnostics.js';
import { readProjectWorkspaceId } from './orient.js';
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
    let dir = path.resolve(startDir);
    for (let i = 0; i < 16; i += 1) {
        const candidate = path.join(dir, '.brainmcp.json');
        if (fs.lstatSync(candidate, { throwIfNoEntry: false })) {
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
    const run = options.runner ?? ((args, timeoutMs) => execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
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
    const numstat = outputOf('diff', read(['diff', '--numstat', 'HEAD'], budget.statsTimeoutMs));
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
        summary: input.summary ? truncateUtf8(scrubSecrets(input.summary), 4_000) : undefined,
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
    const updated = {
        ...current,
        consent: {
            ...current.consent,
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
    const updated = {
        ...current,
        consent: {
            ...current.consent,
            captureEnabled: false,
            includePrompts: false,
            revision: (current.consent.revision ?? 0) + 1,
        },
    };
    writePreferences(updated, options?.baseDir);
    // Cancel only unsent automatic items. Manual items remain explicit user
    // actions, and ambiguous in-flight deliveries retain their honest status.
    const items = listQueueItems(options?.baseDir);
    for (const item of items) {
        if (item.captureTrigger !== 'manual' && item.status === 'pending') {
            updateQueueItem(item.digestId, {
                status: 'cancelled',
                lastError: 'Capture disabled by user',
            }, options?.baseDir);
        }
    }
    return updated;
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
    if (!prefs?.consent?.captureEnabled) {
        return false;
    }
    return CAPTURE_EVENTS.has(event);
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