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
        assertNotSymlink(lockPath);
        const metadata = {
            pid: process.pid,
            createdAt: Date.now(),
            sessionId,
            owner: randomUUID(),
        };
        try {
            // Try atomic exclusive file creation (flag 'wx')
            fs.writeFileSync(lockPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            return lockHandle(lockPath, metadata);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
        }
        const now = Date.now();
        let stale = false;
        try {
            stale = isStaleLock(fs.readFileSync(lockPath, 'utf8'), fs.lstatSync(lockPath).mtimeMs, now);
        }
        catch (err) {
            if (err?.code === 'ENOENT')
                continue; // Released between the create and the read.
        }
        if (stale) {
            const taken = takeOverStaleLock(lockPath, metadata);
            if (taken === 'acquired')
                return lockHandle(lockPath, metadata);
            if (taken === 'retry')
                continue;
        }
        // Check if timeout reached
        if (now - startTime > timeoutMs) {
            throw new SessionLockTimeoutError(sessionId, now - startTime);
        }
        // Asynchronously sleep before retrying
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
}
/**
 * Stale if older than STALE_LOCK_MS and its process is dead. A live holder is never interrupted
 * early, but holders only do short local file work, so a lock older than ABANDONED_LOCK_MS is
 * abandoned even when its PID answers: a crashed holder's PID can be reused by an unrelated
 * process, which would otherwise block this session forever. A lock without readable metadata is
 * judged by its mtime, since an exclusive creator may not have written its metadata yet.
 */
function isStaleLock(text, mtimeMs, now) {
    let meta;
    try {
        meta = JSON.parse(text);
        if (!meta || typeof meta !== 'object' || typeof meta.createdAt !== 'number')
            throw new Error('malformed');
    }
    catch {
        return now - mtimeMs > STALE_LOCK_MS;
    }
    const age = now - meta.createdAt;
    return age > ABANDONED_LOCK_MS || (age > STALE_LOCK_MS && !isProcessAlive(meta.pid));
}
function lockHandle(lockPath, metadata) {
    let released = false;
    return {
        release: () => {
            if (released)
                return;
            released = true;
            // Under the takeover guard, so a takeover of this lock (once it counts as abandoned) cannot
            // land between the owner check and the unlink and have its lock removed. The guard is held
            // only for a few file operations; if it stays busy, release without it as before.
            const releaseGuard = acquireTakeoverGuard(lockPath, GUARD_RELEASE_WAIT_MS);
            try {
                // Verify we still own this lock before unlinking
                const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                if (parsed?.owner === metadata.owner)
                    fs.unlinkSync(lockPath);
            }
            catch {
                // Ignore release errors (already gone, or replaced by a lock that is not ours)
            }
            finally {
                releaseGuard?.();
            }
        },
    };
}
/**
 * Takes the stale lock at `lockPath` over for `metadata`. The lock path is never left empty:
 * contenders that both judged one lock stale once unlinked or renamed it aside, and in the gap a
 * third contender's exclusive create could succeed while the first had already created its own,
 * leaving two holders (review L8). Instead, takeovers (and owner releases and retention pruning)
 * are serialized by the `.takeover` guard file, the lock is judged stale again under the guard,
 * and the new lock replaces it with one atomic rename, so an exclusive create never sees the path
 * free mid-takeover.
 */
function takeOverStaleLock(lockPath, metadata) {
    const releaseGuard = acquireTakeoverGuard(lockPath, 0);
    if (!releaseGuard)
        return 'busy';
    try {
        let stale;
        try {
            stale = isStaleLock(fs.readFileSync(lockPath, 'utf8'), fs.lstatSync(lockPath).mtimeMs, Date.now());
        }
        catch (err) {
            return err?.code === 'ENOENT' ? 'retry' : 'busy';
        }
        if (!stale)
            return 'busy'; // Another contender already took it over (or its owner renewed it).
        const pending = `${lockPath}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(pending, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
            fs.renameSync(pending, lockPath);
        }
        catch {
            try {
                fs.unlinkSync(pending);
            }
            catch {
                // Retention prunes it.
            }
            return 'busy';
        }
        return 'acquired';
    }
    finally {
        releaseGuard();
    }
}
/**
 * Removes the lock at `lockPath` if `isPrunable` still holds for it under the takeover guard (see
 * takeOverStaleLock), so retention never removes a lock that a takeover put in place after
 * retention read the old one. Returns whether it removed the lock.
 */
export function removeLockIfStill(lockPath, isPrunable) {
    const releaseGuard = acquireTakeoverGuard(lockPath, 0);
    if (!releaseGuard)
        return false;
    try {
        if (!isPrunable(fs.readFileSync(lockPath, 'utf8'), fs.lstatSync(lockPath).mtimeMs))
            return false;
        fs.unlinkSync(lockPath);
        return true;
    }
    catch {
        return false;
    }
    finally {
        releaseGuard();
    }
}
const GUARD_SUFFIX = '.takeover';
const GUARD_RELEASE_WAIT_MS = 100;
export function getTakeoverGuardPath(lockPath) {
    return `${lockPath}${GUARD_SUFFIX}`;
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Creates the takeover guard for `lockPath`, waiting up to `waitMs` while another process holds
 * it; returns its release, or null when it stayed busy. A holder keeps the guard for a few file
 * operations, so a guard older than STALE_LOCK_MS was left by a crash and is moved aside (only
 * the contender that moves it removes it). Two holders of the guard are then possible only when a
 * holder died inside those few operations and three contenders recover its guard at once.
 */
function acquireTakeoverGuard(lockPath, waitMs) {
    const guardPath = getTakeoverGuardPath(lockPath);
    const token = JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner: randomUUID() });
    const deadline = Date.now() + waitMs;
    while (true) {
        try {
            assertNotSymlink(guardPath);
            fs.writeFileSync(guardPath, token, { flag: 'wx', mode: 0o600 });
            return () => {
                try {
                    if (fs.readFileSync(guardPath, 'utf8') === token)
                        fs.unlinkSync(guardPath);
                }
                catch {
                    // Already gone.
                }
            };
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                return null;
        }
        let recovered = false;
        try {
            const raw = fs.readFileSync(guardPath, 'utf8');
            if (Date.now() - fs.lstatSync(guardPath).mtimeMs > STALE_LOCK_MS) {
                recovered = removeStaleGuard(guardPath, (text, mtimeMs) => text === raw && Date.now() - mtimeMs > STALE_LOCK_MS);
            }
        }
        catch (err) {
            recovered = err?.code === 'ENOENT'; // Released meanwhile.
        }
        if (recovered)
            continue;
        if (Date.now() >= deadline)
            return null;
        sleepSync(1);
    }
}
/**
 * Removes a guard file left by a crash, and only that file. Contenders that read the same stale
 * guard race to remove it, and a plain unlink by the slower one deletes the guard the faster one
 * has just created. So the file is renamed aside first (only one contender can move a given
 * file) and `stillStale` checks that what was moved is the guard judged stale; anything else is
 * linked back, which never replaces a newer guard. The aside name ends in `.lock`, so retention
 * prunes one a crash left behind.
 */
function removeStaleGuard(guardPath, stillStale) {
    const aside = `${guardPath}.${randomUUID()}.stale.lock`;
    try {
        fs.renameSync(guardPath, aside);
    }
    catch (err) {
        return err?.code === 'ENOENT'; // Another contender moved it first.
    }
    let stale = false;
    try {
        stale = stillStale(fs.readFileSync(aside, 'utf8'), fs.lstatSync(aside).mtimeMs);
    }
    catch {
        // Unreadable now: put it back rather than guess.
    }
    if (!stale) {
        try {
            fs.linkSync(aside, guardPath);
        }
        catch (err) {
            // A newer guard that took the path (EEXIST) stays the guard; otherwise move this one back.
            if (err?.code !== 'EEXIST') {
                try {
                    fs.renameSync(aside, guardPath);
                }
                catch {
                    // Left aside: retention prunes it.
                }
                return false;
            }
        }
    }
    try {
        fs.unlinkSync(aside);
    }
    catch {
        // Retention prunes it.
    }
    return stale;
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