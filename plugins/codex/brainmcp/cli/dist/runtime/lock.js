import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDirectory0700, assertNotSymlink, resolveStateDir } from './storage.js';
const STALE_LOCK_MS = 5000;
const ABANDONED_LOCK_MS = 10 * 60_000;
/**
 * Another live process held the lock for the whole wait. The holder only does
 * short local file work, so this means "busy, retry shortly", not a failure.
 */
export class SessionLockTimeoutError extends Error {
    sessionId;
    waitedMs;
    constructor(sessionId, waitedMs) {
        super(`Timed out waiting for session lock: ${sessionId} (waited ${waitedMs}ms)`);
        this.name = 'SessionLockTimeoutError';
        this.sessionId = sessionId;
        this.waitedMs = waitedMs;
    }
}
export function getSessionLockPath(sessionId, baseDir) {
    const locksDir = path.join(resolveStateDir(baseDir), 'locks');
    ensureDirectory0700(locksDir);
    // Sanitize sessionId for safe filename
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(locksDir, `${safeSessionId}.lock`);
}
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM'; // Exists but belongs to another user
    }
}
export async function acquireSessionLock(sessionId, options) {
    const lockPath = getSessionLockPath(sessionId, options?.baseDir);
    const timeoutMs = options?.timeoutMs ?? 5000;
    const startTime = Date.now();
    const pollInterval = 20;
    while (true) {
        try {
            assertNotSymlink(lockPath);
            // Try atomic exclusive file creation (flag 'wx')
            const metadata = {
                pid: process.pid,
                createdAt: Date.now(),
                sessionId,
                owner: randomUUID(),
            };
            fs.writeFileSync(lockPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            // Acquired lock successfully
            let released = false;
            return {
                release: () => {
                    if (released)
                        return;
                    released = true;
                    try {
                        if (fs.existsSync(lockPath)) {
                            // Verify we still own this lock before unlinking
                            const content = fs.readFileSync(lockPath, 'utf8');
                            const parsed = JSON.parse(content);
                            if (parsed.owner === metadata.owner) {
                                fs.unlinkSync(lockPath);
                            }
                        }
                    }
                    catch {
                        // Ignore release errors
                    }
                },
            };
        }
        catch (err) {
            if (err.code === 'EEXIST') {
                const now = Date.now();
                try {
                    const raw = fs.readFileSync(lockPath, 'utf8');
                    const meta = JSON.parse(raw);
                    const age = now - meta.createdAt;
                    // Stale if older than STALE_LOCK_MS and its process is dead. A live holder is never
                    // interrupted early, but holders only do short local file work, so a lock older than
                    // ABANDONED_LOCK_MS is abandoned even when its PID answers: a crashed holder's PID can be
                    // reused by an unrelated process, which would otherwise block this session forever.
                    if (age > ABANDONED_LOCK_MS || (age > STALE_LOCK_MS && !isProcessAlive(meta.pid))) {
                        // Recover stale lock: remove it and retry immediately
                        try {
                            fs.unlinkSync(lockPath);
                            continue;
                        }
                        catch {
                            // Concurrently unlinked or retried
                        }
                    }
                }
                catch {
                    // Corrupt lock file -> recover by removing
                    try {
                        // An exclusive creator may not yet have written its metadata.
                        if (now - fs.lstatSync(lockPath).mtimeMs > STALE_LOCK_MS) {
                            fs.unlinkSync(lockPath);
                            continue;
                        }
                    }
                    catch {
                        // Ignore
                    }
                }
                // Check if timeout reached
                if (now - startTime > timeoutMs) {
                    throw new SessionLockTimeoutError(sessionId, now - startTime);
                }
                // Asynchronously sleep before retrying
                await new Promise((resolve) => setTimeout(resolve, pollInterval));
                continue;
            }
            throw err;
        }
    }
}
export async function withSessionLock(sessionId, fn, options) {
    const lock = await acquireSessionLock(sessionId, options);
    try {
        return await fn();
    }
    finally {
        lock.release();
    }
}
//# sourceMappingURL=lock.js.map