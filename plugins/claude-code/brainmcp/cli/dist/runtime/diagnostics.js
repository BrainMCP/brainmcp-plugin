import fs from 'node:fs';
import path from 'node:path';
import { ensureDirectory0700, assertNotSymlink, resolveStateDir } from './storage.js';
const SENSITIVE_KEY_PATTERNS = [
    /token/i,
    /bearer/i,
    /auth/i,
    /secret/i,
    /cookie/i,
    /password/i,
    /verifier/i,
    /code/i,
    /prompt/i,
    /assistant/i,
    /content/i,
    /(api|secret|private|access|auth)key$/i,
    /^key$/i,
];
/**
 * Recursively scrubs sensitive values from metadata objects (AHI-D04, AHI-D06).
 */
export function scrubMetadata(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value !== 'object') {
        if (typeof value === 'string') {
            // Scrub potential token patterns
            if (/bearer\s+[a-zA-Z0-9._-]+/i.test(value) || /brain_[a-zA-Z0-9_-]{20,}/i.test(value)) {
                return '[REDACTED_TOKEN]';
            }
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(scrubMetadata);
    }
    const result = {};
    for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(k))) {
            result[k] = '[REDACTED]';
        }
        else {
            result[k] = scrubMetadata(v);
        }
    }
    return result;
}
export function getLogsDir(baseDir) {
    const logsDir = path.join(resolveStateDir(baseDir), 'logs');
    ensureDirectory0700(logsDir);
    return logsDir;
}
export function logRuntimeEvent(level, event, metadata, baseDir) {
    try {
        const logsDir = getLogsDir(baseDir);
        const logFile = path.join(logsDir, 'runtime.log');
        assertNotSymlink(logFile);
        if (fs.existsSync(logFile) && fs.lstatSync(logFile).size >= 5 * 1024 * 1024) {
            // Bound diagnostics even when capture is disabled and no ledger is pruned.
            fs.truncateSync(logFile, 0);
        }
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            event,
            metadata: metadata ? scrubMetadata(metadata) : undefined,
        };
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
    catch {
        // Logging failures fail open
    }
}
//# sourceMappingURL=diagnostics.js.map