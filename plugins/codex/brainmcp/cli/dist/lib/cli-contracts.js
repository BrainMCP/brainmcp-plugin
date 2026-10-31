/**
 * Frozen CLI contracts: command grammar, exit codes, versioned local schemas,
 * normalized hook events, and privacy invariants (AHI-012, AHI-013, AHI-014, AHI-018)
 */
import path from 'node:path';
import { CAPTURE_POLICY_VERSION, scrubDigestSecrets, } from '../agent-config.js';
/** Code points of assistant summary a ledger keeps and a capture sends ("at most 4,000 characters"). */
export const MAX_ASSISTANT_SUMMARY_CHARS = 4_000;
/** The first `maxCodePoints` code points: never splits a surrogate pair, as a UTF-16 `slice` can. */
export function truncateCodePoints(value, maxCodePoints) {
    const points = Array.from(value);
    return points.length <= maxCodePoints ? value : points.slice(0, maxCodePoints).join('');
}
// =====================================================================
// CLI Exit Codes (AHI-012)
// =====================================================================
export const CLI_EXIT_CODES = {
    SUCCESS: 0,
    GENERAL_ERROR: 1,
    USAGE_ERROR: 2,
    AUTH_REQUIRED: 3,
    PERMISSION_DENIED: 4,
    CONFIGURATION_ERROR: 5,
    NETWORK_ERROR: 6,
};
/** A local configuration problem the user must repair; commands exit with CONFIGURATION_ERROR. */
export class CliConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CliConfigurationError';
    }
}
// =====================================================================
// Versioned Schema Versions (AHI-013)
// =====================================================================
export const PREFERENCES_SCHEMA_VERSION = 1;
export const CREDENTIALS_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;
export const CACHE_SCHEMA_VERSION = 1;
export const SESSION_LEDGER_SCHEMA_VERSION = 1;
export const QUEUE_SCHEMA_VERSION = 1;
export const LOGS_SCHEMA_VERSION = 1;
export function validatePreferencesRecord(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Preferences must be an object');
    }
    const obj = data;
    if (obj.version !== PREFERENCES_SCHEMA_VERSION) {
        throw new Error(`Unsupported preferences schema version: ${String(obj.version)}`);
    }
    if (!obj.consent || typeof obj.consent !== 'object') {
        throw new Error('Preferences must include a consent object');
    }
    const consent = obj.consent;
    if (typeof consent.captureEnabled !== 'boolean') {
        throw new Error('consent.captureEnabled must be a boolean');
    }
    if (typeof consent.includePrompts !== 'boolean') {
        throw new Error('consent.includePrompts must be a boolean');
    }
    if (typeof consent.policyVersion !== 'string' || !consent.policyVersion) {
        throw new Error('consent.policyVersion must be a non-empty string');
    }
    return {
        version: PREFERENCES_SCHEMA_VERSION,
        consent: {
            captureEnabled: consent.captureEnabled,
            includePrompts: consent.includePrompts,
            policyVersion: consent.policyVersion,
            consentedAt: typeof consent.consentedAt === 'string' ? consent.consentedAt : undefined,
            revision: typeof consent.revision === 'number' && Number.isSafeInteger(consent.revision)
                ? Math.max(0, consent.revision)
                : 0,
            ...(typeof consent.lastDisabledRevision === 'number' && Number.isSafeInteger(consent.lastDisabledRevision)
                ? { lastDisabledRevision: Math.max(0, consent.lastDisabledRevision) }
                : {}),
        },
        enabledWorkspaceId: typeof obj.enabledWorkspaceId === 'string' ? obj.enabledWorkspaceId : undefined,
        nudgeEnabled: typeof obj.nudgeEnabled === 'boolean' ? obj.nudgeEnabled : false,
    };
}
export function validateStateRecord(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('State must be an object');
    }
    const obj = data;
    if (obj.version !== STATE_SCHEMA_VERSION) {
        throw new Error(`Unsupported state schema version: ${String(obj.version)}`);
    }
    return {
        version: STATE_SCHEMA_VERSION,
        authorizationId: typeof obj.authorizationId === 'string' ? obj.authorizationId : undefined,
        workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : undefined,
        orientCursor: typeof obj.orientCursor === 'string' ? obj.orientCursor : undefined,
        cacheMeta: obj.cacheMeta && typeof obj.cacheMeta === 'object' ? obj.cacheMeta : undefined,
    };
}
export function validateSessionLedgerRecord(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Session ledger must be an object');
    }
    const obj = data;
    if (obj.version !== SESSION_LEDGER_SCHEMA_VERSION) {
        throw new Error(`Unsupported session ledger schema version: ${String(obj.version)}`);
    }
    if (typeof obj.sessionKey !== 'string' || !obj.sessionKey) {
        throw new Error('Session ledger requires a sessionKey');
    }
    return {
        version: SESSION_LEDGER_SCHEMA_VERSION,
        sessionKey: obj.sessionKey,
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
        lastEventAt: typeof obj.lastEventAt === 'string' ? obj.lastEventAt : new Date().toISOString(),
        eventSequence: typeof obj.eventSequence === 'number' ? obj.eventSequence : 0,
        lastMeaningfulAt: typeof obj.lastMeaningfulAt === 'string' ? obj.lastMeaningfulAt : undefined,
        lastMeaningfulSequence: typeof obj.lastMeaningfulSequence === 'number' ? obj.lastMeaningfulSequence : undefined,
        lastSuccessfulWriteBackAt: typeof obj.lastSuccessfulWriteBackAt === 'string' ? obj.lastSuccessfulWriteBackAt : undefined,
        lastSuccessfulWriteBackSequence: typeof obj.lastSuccessfulWriteBackSequence === 'number' ? obj.lastSuccessfulWriteBackSequence : undefined,
        lastCapturedAt: typeof obj.lastCapturedAt === 'string' ? obj.lastCapturedAt : undefined,
        lastCapturedSequence: typeof obj.lastCapturedSequence === 'number' ? obj.lastCapturedSequence : undefined,
        lastNudgedAt: typeof obj.lastNudgedAt === 'string' ? obj.lastNudgedAt : undefined,
        lastNudgedSequence: typeof obj.lastNudgedSequence === 'number' ? obj.lastNudgedSequence : undefined,
        editedPaths: Array.isArray(obj.editedPaths) ? obj.editedPaths.filter((p) => typeof p === 'string').slice(0, 100) : [],
        prompts: Array.isArray(obj.prompts) ? obj.prompts.filter((p) => typeof p === 'string').slice(0, 50) : undefined,
        assistantSummary: typeof obj.assistantSummary === 'string' ? truncateCodePoints(obj.assistantSummary, MAX_ASSISTANT_SUMMARY_CHARS) : undefined,
        model: typeof obj.model === 'string' ? obj.model.slice(0, 120) : undefined,
        deliveryIds: Array.isArray(obj.deliveryIds) ? obj.deliveryIds.filter((d) => typeof d === 'string').slice(-100) : [],
        captureRevision: typeof obj.captureRevision === 'number' ? obj.captureRevision : undefined,
        projectKey: typeof obj.projectKey === 'string' ? obj.projectKey : undefined,
        workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : undefined,
    };
}
/** Bounds for `projectRoots`: hosts report a handful of workspace folders. */
export const MAX_QUEUE_PROJECT_ROOTS = 32;
export const MAX_QUEUE_PROJECT_ROOT_CHARS = 4096;
const QUEUE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
// `satisfies` makes typecheck fail when a contract value is added or removed.
const CAPTURE_TRIGGERS = { manual: true, pre_compact: true, session_end: true };
const CAPTURE_FAILURE_CLASSES = {
    non_retryable: true,
    auth_required: true,
    terminal: true,
    retry_exhausted: true,
};
const CAPTURE_QUEUE_STATUSES = {
    pending: true,
    sending: true,
    delivered: true,
    failed: true,
    cancelled: true,
    delivery_unknown: true,
};
/**
 * A missing field takes the legacy default; any other value must be one of the
 * contract's. An unknown status (say `deliverd`) is not terminal to the flush,
 * which would claim and resend it, so the item is rejected and listing skips it.
 */
function queueEnumField(value, allowed, fallback, field) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === 'string' && Object.hasOwn(allowed, value))
        return value;
    throw new Error(`Queue item has an unknown ${field}`);
}
export function validateQueueItemRecord(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Queue item must be an object');
    }
    const obj = data;
    if (obj.version !== QUEUE_SCHEMA_VERSION) {
        throw new Error(`Unsupported queue schema version: ${String(obj.version)}`);
    }
    if (typeof obj.digestId !== 'string' || !obj.digestId) {
        throw new Error('Queue item requires a digestId');
    }
    if (typeof obj.workspaceId !== 'string' || !obj.workspaceId) {
        throw new Error('Queue item requires a workspaceId');
    }
    return {
        version: QUEUE_SCHEMA_VERSION,
        digestId: obj.digestId,
        workspaceId: obj.workspaceId,
        captureTrigger: queueEnumField(obj.captureTrigger, CAPTURE_TRIGGERS, 'manual', 'captureTrigger'),
        policyVersion: typeof obj.policyVersion === 'string' ? obj.policyVersion : CAPTURE_POLICY_VERSION,
        digestText: typeof obj.digestText === 'string' ? obj.digestText : '',
        authorizationId: typeof obj.authorizationId === 'string' ? obj.authorizationId : undefined,
        consentRevision: typeof obj.consentRevision === 'number' && Number.isSafeInteger(obj.consentRevision)
            ? Math.max(0, obj.consentRevision)
            : undefined,
        status: queueEnumField(obj.status, CAPTURE_QUEUE_STATUSES, 'pending', 'status'),
        attempts: typeof obj.attempts === 'number' ? obj.attempts : 0,
        nextRetryAt: typeof obj.nextRetryAt === 'string' ? obj.nextRetryAt : undefined,
        lastError: typeof obj.lastError === 'string' ? obj.lastError : undefined,
        lastErrorCode: typeof obj.lastErrorCode === 'string' && QUEUE_ERROR_CODE_RE.test(obj.lastErrorCode)
            ? obj.lastErrorCode : undefined,
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
        updatedAt: typeof obj.updatedAt === 'string'
            ? obj.updatedAt
            : typeof obj.createdAt === 'string'
                ? obj.createdAt
                : new Date().toISOString(),
        deliveredAt: typeof obj.deliveredAt === 'string' ? obj.deliveredAt : undefined,
        deliveryLease: obj.deliveryLease && typeof obj.deliveryLease === 'object' &&
            typeof obj.deliveryLease.owner === 'string' &&
            typeof obj.deliveryLease.expiresAt === 'string'
            ? obj.deliveryLease : undefined,
        // Advisory only (the status decides delivery), so an unknown value is dropped, not rejected.
        failureClass: typeof obj.failureClass === 'string' && Object.hasOwn(CAPTURE_FAILURE_CLASSES, obj.failureClass)
            ? obj.failureClass : undefined,
        // A malformed list reads as missing, which the flush treats as unverifiable.
        projectRoots: Array.isArray(obj.projectRoots) && obj.projectRoots.length <= MAX_QUEUE_PROJECT_ROOTS &&
            obj.projectRoots.every((root) => typeof root === 'string' && root.length > 0 && root.length <= MAX_QUEUE_PROJECT_ROOT_CHARS)
            ? [...obj.projectRoots] : undefined,
    };
}
// =====================================================================
// Privacy and Sanitization Helpers (AHI-018, AHI-D06, AHI-D18)
// =====================================================================
const WORKSPACE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Workspace ids are UUIDs; MCP tools, capture, and orientation accept no slug or name. */
export function isWorkspaceUuid(value) {
    return WORKSPACE_UUID_RE.test(value);
}
/**
 * Workspace UUIDs match case-insensitively, and the API's canonical form is
 * lower case: ids from flags, bindings and the server are normalized on the
 * way in so every later comparison is plain equality.
 */
export function normalizeWorkspaceId(value) {
    return value.trim().toLowerCase();
}
/**
 * Redacts credentials with the patterns the API applies before storing a
 * digest (`scrubDigestSecrets`), so ledger prompts and summaries, queued
 * payloads, and `capture now --dry-run` output keep nothing the server would
 * redact on receipt.
 */
export function scrubSecrets(input) {
    return scrubDigestSecrets(input);
}
/**
 * A JSON syntax error that never quotes the input. V8's own SyntaxError message
 * echoes a slice of the text it failed on, which for local state can be part of
 * an access token, a prompt, or a digest; only the character offset is kept.
 */
export class InvalidJsonError extends Error {
    subject;
    position;
    constructor(subject, position) {
        super(`${subject} is not valid JSON${position === undefined ? '' : ` (position ${position})`}`);
        this.subject = subject;
        this.position = position;
        this.name = 'InvalidJsonError';
    }
}
/** Character offset from a V8 JSON SyntaxError, read only from the message's fixed suffix. */
export function jsonSyntaxErrorPosition(error) {
    if (!(error instanceof SyntaxError))
        return undefined;
    const match = / at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(error.message);
    return match ? Number(match[1]) : undefined;
}
/** `JSON.parse` whose failure is an InvalidJsonError naming `subject`, never the input. */
export function parseJsonWithoutEcho(raw, subject) {
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        throw new InvalidJsonError(subject, jsonSyntaxErrorPosition(error));
    }
}
/**
 * Root-relative forms of edited paths for the local session ledger. Paths are
 * normalized first, so `/root/../x` is outside the root rather than `../x`;
 * anything that still climbs out (`..`, `../x`) is dropped, matching the
 * traversal rule `buildDigestPayload` applies before a digest leaves the machine.
 */
export function filterRelativePaths(paths, rootDir) {
    const normalizedRoot = path.posix.normalize(rootDir.replace(/\\/g, '/')).replace(/\/+$/, '');
    const out = [];
    for (const raw of paths) {
        let p = path.posix.normalize(raw.replace(/\\/g, '/'));
        if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) {
            if (!p.startsWith(normalizedRoot + '/'))
                continue;
            p = p.slice(normalizedRoot.length + 1);
        }
        if (p === '.' || p.split('/').includes('..'))
            continue;
        out.push(p);
    }
    return out;
}
//# sourceMappingURL=cli-contracts.js.map