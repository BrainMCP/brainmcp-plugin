import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SESSION_LEDGER_SCHEMA_VERSION, validateSessionLedgerRecord, scrubSecrets, } from '../lib/cli-contracts.js';
import { enqueueCaptureItem, listQueueItems } from './queue.js';
import { canEnqueueCapture } from './flush.js';
import { ensureDirectory0700, writeAtomic0600, readSafeJson, resolveStateDir } from './storage.js';
import { withSessionLock } from './lock.js';
/**
 * A Brain tool's own name without the host's MCP prefix. Hosts prefix MCP tools
 * with the server key: `mcp__brain__brain_remember` from a configured `brain`
 * server, and `mcp__plugin_brainmcp_brain__brain_remember` from the Claude Code
 * plugin's server. The prefix is stripped only in front of a `brain_` name.
 */
export function bareBrainToolName(toolName) {
    return toolName.replace(/^mcp__.+?__(?=brain_)/, '');
}
/**
 * Parse structured Brain tool results to distinguish proposal created/applied/idempotent
 * from failed calls and digest capture (AHI-056).
 */
export function parseBrainToolResult(toolName, toolResult) {
    toolName = bareBrainToolName(toolName);
    if (!toolName || !toolResult) {
        return { isWriteBack: false };
    }
    // Digest capture or read operations NEVER count as graph write-back
    if (toolName === 'brain_session_digest' ||
        toolName === 'brain_digest_pending' ||
        toolName === 'brain_digest_complete' ||
        toolName.includes('read') ||
        toolName.includes('overview') ||
        toolName.includes('search') ||
        toolName.includes('list')) {
        return { isWriteBack: false };
    }
    let resultObj = toolResult;
    if (typeof toolResult === 'string') {
        try {
            resultObj = JSON.parse(toolResult);
        }
        catch {
            // Plain text output is not structured tool result
            return { isWriteBack: false };
        }
    }
    if (typeof resultObj !== 'object' || resultObj === null) {
        return { isWriteBack: false };
    }
    // If MCP call returned isError or error field
    if (resultObj.isError || resultObj.error) {
        return { isWriteBack: false, status: 'error' };
    }
    // Current MCP results wrap the payload in structuredContent/data. Some
    // hosts expose the serialized text-content fallback instead.
    if (resultObj.structuredContent)
        return parseBrainToolResult(toolName, resultObj.structuredContent);
    if (resultObj.kind === 'tool_error')
        return { isWriteBack: false, status: 'error' };
    if (resultObj.data && typeof resultObj.data === 'object')
        return parseBrainToolResult(toolName, resultObj.data);
    if (Array.isArray(resultObj.content)) {
        for (const block of resultObj.content.slice(0, 8)) {
            if (block?.type !== 'text' || typeof block.text !== 'string')
                continue;
            const parsed = parseBrainToolResult(toolName, block.text);
            if (parsed.isWriteBack)
                return parsed;
        }
        return { isWriteBack: false };
    }
    // Handle brain_change_propose / brain_remember / brain_amend
    if (toolName === 'brain_change_propose' ||
        toolName === 'brain_remember' ||
        toolName === 'brain_amend' ||
        toolName === 'brain_tags_set') {
        const proposal = resultObj.proposal ?? resultObj;
        const status = proposal.status ?? resultObj.status;
        const proposalId = proposal.id ?? resultObj.id ?? resultObj.proposalId;
        if (status === 'applied' && proposalId) {
            const isIdempotent = Boolean(resultObj.idempotentReplay || resultObj.idempotent || proposal.idempotent);
            return {
                isWriteBack: true,
                actionKind: isIdempotent ? 'idempotent' : 'proposal_applied',
                status: 'applied',
                proposalId,
            };
        }
        if (proposalId && (status === 'pending' || status === 'pending_review' || status === 'review_required' || status === 'queued')) {
            return {
                isWriteBack: true,
                actionKind: 'proposal_created',
                status: 'pending_review',
                proposalId,
                note: 'Proposal created awaiting review',
            };
        }
        if (status === 'rejected' || status === 'failed') {
            return { isWriteBack: false, status };
        }
        // Default if proposal created with an ID
        if (proposalId) {
            return {
                isWriteBack: true,
                actionKind: 'proposal_created',
                proposalId,
                status: status ?? 'created',
            };
        }
    }
    return { isWriteBack: false };
}
export function getSessionLedgerPath(sessionKey, baseDir) {
    const sessionsDir = path.join(resolveStateDir(baseDir), 'sessions');
    ensureDirectory0700(sessionsDir);
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(sessionsDir, `${safeKey}.json`);
}
export function loadSessionLedger(sessionKey, baseDir) {
    const filePath = getSessionLedgerPath(sessionKey, baseDir);
    const existing = readSafeJson(filePath, validateSessionLedgerRecord);
    if (existing) {
        return existing;
    }
    const now = new Date().toISOString();
    return {
        version: SESSION_LEDGER_SCHEMA_VERSION,
        sessionKey,
        createdAt: now,
        lastEventAt: now,
        eventSequence: 0,
        editedPaths: [],
        deliveryIds: [],
    };
}
export function saveSessionLedger(sessionKey, ledger, baseDir) {
    const filePath = getSessionLedgerPath(sessionKey, baseDir);
    writeAtomic0600(filePath, JSON.stringify(ledger, null, 2));
}
/** Session ledgers read when choosing the latest one; the newest files by mtime come first. */
export const MAX_LEDGERS_SCANNED = 1_000;
/**
 * Return the most recently active valid session ledger without creating one.
 * Manual capture uses this bounded local record instead of inventing content or
 * opening host transcript files.
 *
 * Ledger filenames are hashes, so directory order says nothing about recency:
 * the scan is bounded to the `maxLedgers` most recently written regular files
 * (every event rewrites its ledger), and other projects' ledgers in that window
 * are skipped.
 */
export function loadMostRecentSessionLedger(baseDir, projectKey, options) {
    const sessionsDir = path.join(resolveStateDir(baseDir), 'sessions');
    if (!fs.existsSync(sessionsDir))
        return null;
    const directory = fs.lstatSync(sessionsDir);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
        throw new Error(`Security violation: ${sessionsDir} is not a safe session directory`);
    }
    const candidates = fs.readdirSync(sessionsDir).flatMap((entry) => {
        if (!entry.endsWith('.json'))
            return [];
        const filePath = path.join(sessionsDir, entry);
        try {
            const stat = fs.lstatSync(filePath);
            return stat.isFile() && !stat.isSymbolicLink() ? [{ filePath, mtimeMs: stat.mtimeMs }] : [];
        }
        catch {
            return [];
        }
    });
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let latest = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const { filePath, mtimeMs } of candidates.slice(0, options?.maxLedgers ?? MAX_LEDGERS_SCANNED)) {
        try {
            const ledger = readSafeJson(filePath, validateSessionLedgerRecord);
            if (!ledger)
                continue;
            if (projectKey && ledger.projectKey !== projectKey)
                continue;
            const timestamp = Date.parse(ledger.lastEventAt);
            const comparable = Number.isFinite(timestamp) ? timestamp : mtimeMs;
            if (comparable > latestAt) {
                latest = ledger;
                latestAt = comparable;
            }
        }
        catch {
            // A malformed, unsafe, or stale entry must not block other valid ledgers.
        }
    }
    return latest;
}
/**
 * Updates session ledger under session lock maintaining monotonic sequence counters (AHI-055).
 */
export async function recordSessionEvent(input) {
    return withSessionLock(input.sessionKey, async () => {
        const ledger = loadSessionLedger(input.sessionKey, input.baseDir);
        const timestamp = input.now ?? new Date().toISOString();
        if (input.captureRevision !== undefined && (ledger.captureRevision !== input.captureRevision || ledger.workspaceId !== input.workspaceId)) {
            ledger.prompts = [];
            ledger.editedPaths = [];
            ledger.assistantSummary = undefined;
            ledger.model = undefined;
            ledger.lastCapturedSequence = ledger.eventSequence;
            ledger.captureRevision = input.captureRevision;
            ledger.workspaceId = input.workspaceId;
        }
        // Monotonic sequence bump
        ledger.eventSequence += 1;
        ledger.lastEventAt = timestamp;
        if (input.projectKey)
            ledger.projectKey = input.projectKey;
        if (input.editedPath && !ledger.editedPaths.includes(input.editedPath)) {
            if (ledger.editedPaths.length >= 100) {
                ledger.editedPaths.shift();
            }
            ledger.editedPaths.push(input.editedPath);
        }
        if (input.prompt && input.persistPrompts) {
            if (!ledger.prompts)
                ledger.prompts = [];
            if (ledger.prompts.length >= 50) {
                ledger.prompts.shift();
            }
            ledger.prompts.push(scrubSecrets(input.prompt).slice(0, 1000));
        }
        if (input.assistantSummary?.trim()) {
            ledger.assistantSummary = scrubSecrets(input.assistantSummary.trim()).slice(0, 4000);
        }
        if (input.model?.trim()) {
            ledger.model = input.model.trim().slice(0, 120);
        }
        if (input.deliveryId && !ledger.deliveryIds.includes(input.deliveryId)) {
            ledger.deliveryIds.push(input.deliveryId);
            ledger.deliveryIds = ledger.deliveryIds.slice(-100);
        }
        if (input.isMeaningful) {
            ledger.lastMeaningfulAt = timestamp;
            ledger.lastMeaningfulSequence = Math.max(ledger.lastMeaningfulSequence ?? 0, ledger.eventSequence);
        }
        // Check tool result for structured Brain write-back (AHI-056)
        if (input.toolResult) {
            const parsed = parseBrainToolResult(input.toolResult.toolName, input.toolResult.result);
            if (parsed.isWriteBack) {
                ledger.lastSuccessfulWriteBackAt = timestamp;
                ledger.lastSuccessfulWriteBackSequence = Math.max(ledger.lastSuccessfulWriteBackSequence ?? 0, ledger.eventSequence);
            }
        }
        saveSessionLedger(input.sessionKey, ledger, input.baseDir);
        return ledger;
    }, { baseDir: input.baseDir, timeoutMs: 250 });
}
/**
 * The queue digest ID of one session slice. It is deterministic so a crash
 * between enqueue and ledger save retries the same server idempotency key, and
 * it omits the trigger, so a manual and an automatic capture of the same slice
 * share it and `capture now` can find whichever was queued.
 */
export function sessionSliceDigestId(input) {
    const hash = createHash('sha256').update(JSON.stringify([input.sessionKey, input.capturedThroughSequence,
        input.authorizationId, input.consentRevision, input.workspaceId])).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
/** Reserve a sequence and enqueue it in the same local critical section. */
export async function queueSessionCapture(input) {
    return withSessionLock(input.sessionKey, () => withSessionLock('capture-queue', () => {
        const ledger = loadSessionLedger(input.sessionKey, input.baseDir);
        const capturedThrough = ledger.lastCapturedSequence ?? 0;
        if (capturedThrough >= input.capturedThroughSequence) {
            return { kind: 'already_captured', capturedThroughSequence: capturedThrough };
        }
        const digestId = sessionSliceDigestId({ ...input.item, sessionKey: input.sessionKey,
            capturedThroughSequence: input.capturedThroughSequence });
        let item = listQueueItems(input.baseDir).find((queued) => queued.digestId === digestId);
        const kind = item ? 'existing' : 'queued';
        if (!item) {
            // Only a genuinely new slice counts against the cap.
            if (!canEnqueueCapture(input.baseDir))
                return { kind: 'queue_full' };
            let digestText = input.item.digestText;
            try {
                const payload = JSON.parse(digestText);
                if (payload && typeof payload === 'object' && 'clientDigestId' in payload)
                    digestText = JSON.stringify({ ...payload, clientDigestId: digestId });
            }
            catch { /* A bounded plain-text digest is also valid. */ }
            item = enqueueCaptureItem({ ...input.item, digestId, digestText }, input.baseDir);
        }
        ledger.lastCapturedAt = item.createdAt;
        ledger.lastCapturedSequence = input.capturedThroughSequence;
        ledger.deliveryIds = [...ledger.deliveryIds, item.digestId].slice(-100);
        saveSessionLedger(input.sessionKey, ledger, input.baseDir);
        return { kind, item };
    }, { baseDir: input.baseDir, timeoutMs: 250 }), { baseDir: input.baseDir, timeoutMs: 250 });
}
export async function markSessionNudged(input) {
    return withSessionLock(input.sessionKey, async () => {
        const ledger = loadSessionLedger(input.sessionKey, input.baseDir);
        ledger.lastNudgedAt = input.now ?? new Date().toISOString();
        ledger.lastNudgedSequence = Math.max(ledger.lastNudgedSequence ?? 0, input.nudgedThroughSequence);
        saveSessionLedger(input.sessionKey, ledger, input.baseDir);
        return ledger;
    }, { baseDir: input.baseDir });
}
//# sourceMappingURL=session.js.map