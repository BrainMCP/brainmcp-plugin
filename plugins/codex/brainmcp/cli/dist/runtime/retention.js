import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBrainHome, assertNotSymlink, resolveStateDir } from './storage.js';
import { listQueueItems, removeQueueItem } from './queue.js';
import { isProcessAlive, removeLockIfStill } from './lock.js';
import { logRuntimeEvent } from './diagnostics.js';
import { pruneBackups } from '../lib/backups.js';
import { BLOCKED_HOST_SESSION_MAX_AGE_MS, BLOCKED_HOST_SESSIONS_DIR } from './session.js';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const FIVE_MB_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 1024 * 1024;
function listOwnedJsonFiles(directory, accepts) {
    if (!fs.existsSync(directory))
        return [];
    assertNotSymlink(directory);
    return fs.readdirSync(directory).flatMap((entry) => {
        if (!accepts(entry))
            return [];
        const filePath = path.join(directory, entry);
        try {
            const stat = fs.lstatSync(filePath);
            return stat.isFile() && !stat.isSymbolicLink() ? [filePath] : [];
        }
        catch {
            return [];
        }
    });
}
export function previewCapturePurge(baseDir) {
    const stateDir = resolveStateDir(baseDir);
    return {
        queueItems: listOwnedJsonFiles(path.join(stateDir, 'queue'), (name) => name.endsWith('.json')).length,
        sessionLedgers: listOwnedJsonFiles(path.join(stateDir, 'sessions'), (name) => name.endsWith('.json')).length,
        orientationCacheFiles: listOwnedJsonFiles(path.join(stateDir, 'cache'), (name) => name.startsWith('orient-') && name.endsWith('.json')).length,
    };
}
/** Delete only BrainMCP-owned queue, session-ledger, and orientation-cache files. */
export function purgeCaptureLocalState(baseDir) {
    const stateDir = resolveStateDir(baseDir);
    const groups = [
        listOwnedJsonFiles(path.join(stateDir, 'queue'), (name) => name.endsWith('.json')),
        listOwnedJsonFiles(path.join(stateDir, 'sessions'), (name) => name.endsWith('.json')),
        listOwnedJsonFiles(path.join(stateDir, 'cache'), (name) => name.startsWith('orient-') && name.endsWith('.json')),
    ];
    const removed = {
        queueItems: 0,
        sessionLedgers: 0,
        orientationCacheFiles: 0,
    };
    const keys = ['queueItems', 'sessionLedgers', 'orientationCacheFiles'];
    groups.forEach((files, index) => {
        for (const filePath of files) {
            try {
                fs.unlinkSync(filePath);
                removed[keys[index]] += 1;
            }
            catch {
                // Report only confirmed deletions; callers can preview again if needed.
            }
        }
    });
    return removed;
}
/**
 * Safely prunes expired queue items, old session ledgers, stale locks, and
 * configuration backups, and trims logs (AHI-058).
 * Never touches active credentials or installed runtime files.
 */
export function pruneLocalState(options) {
    const brainHome = options?.brainHome ?? options?.baseDir ?? getBrainHome();
    const baseDir = resolveStateDir(options?.baseDir ?? brainHome);
    const now = options?.now ?? Date.now();
    const maxQueueAge = options?.maxQueueAgeMs ?? SEVEN_DAYS_MS;
    const maxSessionAge = options?.maxSessionAgeMs ?? FOURTEEN_DAYS_MS;
    const maxBlockedHostSessionAge = Math.max(maxSessionAge, BLOCKED_HOST_SESSION_MAX_AGE_MS);
    const maxLogSize = options?.maxLogSizeBytes ?? FIVE_MB_BYTES;
    let prunedQueueCount = 0;
    const prunedUndelivered = { total: 0, manual: 0, active: 0, failed: 0, cancelled: 0 };
    let prunedSessionCount = 0;
    let prunedLockCount = 0;
    let logRotated = false;
    // 1. Prune queue items
    try {
        const items = listQueueItems(baseDir);
        for (const item of items) {
            const createdAtMs = new Date(item.createdAt).getTime();
            if (now - createdAtMs > maxQueueAge || item.status === 'delivered') {
                if (removeQueueItem(item.digestId, baseDir)) {
                    prunedQueueCount += 1;
                    if (item.status !== 'delivered') {
                        prunedUndelivered.total += 1;
                        if (item.captureTrigger === 'manual')
                            prunedUndelivered.manual += 1;
                        if (item.status === 'failed' || item.status === 'cancelled')
                            prunedUndelivered[item.status] += 1;
                        else
                            prunedUndelivered.active += 1;
                    }
                }
            }
        }
    }
    catch {
        // Ignore pruning errors
    }
    if (prunedUndelivered.total > 0) {
        // Retention dropped digests that never reached the server; record that it happened.
        logRuntimeEvent('warn', 'capture_queue_pruned_undelivered', { ...prunedUndelivered }, baseDir);
    }
    // 2. Prune old session files
    const sessionsDir = path.join(baseDir, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        try {
            assertNotSymlink(sessionsDir);
            const sessionFiles = fs.readdirSync(sessionsDir);
            for (const file of sessionFiles) {
                if (!file.endsWith('.json'))
                    continue;
                const filePath = path.join(sessionsDir, file);
                try {
                    const stat = fs.lstatSync(filePath);
                    if (!stat.isSymbolicLink() && now - stat.mtimeMs > maxSessionAge) {
                        fs.unlinkSync(filePath);
                        prunedSessionCount += 1;
                    }
                }
                catch {
                    // Ignore
                }
            }
        }
        catch {
            // Ignore
        }
    }
    // 2b. Blocked-host-session markers (in the Brain home, across accounts) outlive the ledgers:
    // a host can resume a session after 14 days with its whole transcript.
    const blockedDir = path.join(brainHome, BLOCKED_HOST_SESSIONS_DIR);
    if (fs.existsSync(blockedDir)) {
        try {
            assertNotSymlink(blockedDir);
            for (const file of fs.readdirSync(blockedDir)) {
                if (!file.endsWith('.json'))
                    continue;
                const filePath = path.join(blockedDir, file);
                try {
                    const stat = fs.lstatSync(filePath);
                    if (!stat.isSymbolicLink() && now - stat.mtimeMs > maxBlockedHostSessionAge)
                        fs.unlinkSync(filePath);
                }
                catch {
                    // Ignore
                }
            }
        }
        catch {
            // Ignore
        }
    }
    // 3. Prune stale locks (> 1 hour old or definitely dead)
    const locksDir = path.join(baseDir, 'locks');
    if (fs.existsSync(locksDir)) {
        try {
            assertNotSymlink(locksDir);
            const lockFiles = fs.readdirSync(locksDir);
            for (const file of lockFiles) {
                const filePath = path.join(locksDir, file);
                if (file.endsWith('.tmp')) {
                    // A takeover's pending lock is renamed into place within a few file operations, so an
                    // old one was left by a crash (see lock.ts).
                    try {
                        const stat = fs.lstatSync(filePath);
                        if (!stat.isSymbolicLink() && now - stat.mtimeMs > 60 * 1000)
                            fs.unlinkSync(filePath);
                    }
                    catch {
                        // Ignore
                    }
                    continue;
                }
                if (!file.endsWith('.lock'))
                    continue;
                try {
                    const stat = fs.lstatSync(filePath);
                    if (stat.isSymbolicLink() || now - stat.mtimeMs <= 60 * 1000)
                        continue;
                    // Judged again under the lock's takeover guard: a takeover may have replaced the lock read
                    // here with a live one, which a plain unlink would remove (review L8).
                    const pruned = removeLockIfStill(filePath, (text, mtimeMs) => {
                        if (now - mtimeMs <= 60 * 1000)
                            return false;
                        try {
                            return !isProcessAlive(JSON.parse(text).pid);
                        }
                        catch {
                            return true; // Old malformed locks have no owner to protect.
                        }
                    });
                    if (pruned)
                        prunedLockCount += 1;
                }
                catch {
                    // Ignore
                }
            }
        }
        catch {
            // Ignore
        }
    }
    // 4. Prune configuration backups. They belong to the brain home, not an account.
    let prunedBackupCount = 0;
    try {
        prunedBackupCount = pruneBackups({ brainHome, now });
    }
    catch {
        // Ignore
    }
    // 5. Rotate the runtime log if it exceeds the size limit
    const logFile = path.join(baseDir, 'logs', 'runtime.log');
    if (fs.existsSync(logFile)) {
        try {
            logRotated = rotateRuntimeLog(logFile, maxLogSize);
        }
        catch {
            // Ignore
        }
    }
    return {
        prunedQueueCount,
        prunedUndelivered,
        prunedSessionCount,
        prunedLockCount,
        prunedBackupCount,
        logRotated,
    };
}
/** Read exactly `length` bytes at `position`, or fewer if the file is shorter now. */
function readRange(filePath, position, length) {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
            const bytesRead = fs.readSync(fd, buffer, filled, length - filled, position + filled);
            if (bytesRead === 0)
                break;
            filled += bytesRead;
        }
        return buffer.subarray(0, filled);
    }
    finally {
        fs.closeSync(fd);
    }
}
/**
 * Replace an oversized runtime log with its most recent whole lines (at most
 * `keepBytes`, never more than `maxLogSize`).
 *
 * Only bytes actually read are kept (a short read never pads with NULs), the
 * tail is written to a sibling temp file and renamed over the log, and rotation
 * is skipped when the log changed while the tail was copied: a concurrent
 * appender (diagnostics.ts appends without a lock) or the logger's own 5 MB
 * truncate. The next prune retries; the logger caps the file meanwhile.
 * `afterTailCopied` is a test seam for simulating that concurrent write.
 */
export function rotateRuntimeLog(logFile, maxLogSize, options = {}) {
    assertNotSymlink(logFile);
    const before = fs.lstatSync(logFile);
    if (!before.isFile() || before.size <= maxLogSize)
        return false;
    const keepBytes = Math.max(0, Math.min(options.keepBytes ?? LOG_KEEP_BYTES, maxLogSize));
    const start = before.size - keepBytes;
    // One extra byte before the cut shows whether it landed on a line boundary.
    const window = readRange(logFile, start - 1, keepBytes + 1);
    if (window.length < keepBytes + 1)
        return false;
    const firstBreak = window.indexOf(0x0a);
    const tail = firstBreak === -1 ? Buffer.alloc(0) : window.subarray(firstBreak + 1);
    options.afterTailCopied?.();
    const tempFile = path.join(path.dirname(logFile), `.${path.basename(logFile)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tempFile, tail, { mode: 0o600, flag: 'wx' });
        const latest = fs.lstatSync(logFile);
        if (latest.ino !== before.ino || latest.size !== before.size || !latest.isFile()) {
            fs.unlinkSync(tempFile);
            return false;
        }
        fs.renameSync(tempFile, logFile);
        return true;
    }
    catch (error) {
        try {
            fs.unlinkSync(tempFile);
        }
        catch {
            // Already renamed or never created.
        }
        throw error;
    }
}
//# sourceMappingURL=retention.js.map