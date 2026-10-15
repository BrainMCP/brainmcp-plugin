import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiClient } from '../lib/api-client.js';
import { createDefaultCredentialStore } from '../lib/credentials.js';
import { logRuntimeEvent } from './diagnostics.js';
import { flushCaptureQueue } from './flush.js';
import { SessionLockTimeoutError, withSessionLock } from './lock.js';
import { listQueueItems } from './queue.js';
import { assertNotSymlink, readSafeJson, resolveStateDir, writeAtomic0600 } from './storage.js';
/**
 * Background capture delivery. A digest POST (often after a token refresh)
 * takes longer than any hook may block its host, so hooks only queue and
 * start a detached runtime process with this argument, which delivers under
 * its own deadline after the hook has returned. One flusher lease per account
 * state directory keeps frequent hooks from starting more than one.
 */
export const BACKGROUND_FLUSH_ARG = '--flush-capture';
/** Whole-run deadline for one background delivery process. */
export const BACKGROUND_FLUSH_DEADLINE_MS = 60_000;
/** Per-request deadline in the background run: room for a cold API Worker plus a token refresh. */
export const BACKGROUND_FLUSH_REQUEST_TIMEOUT_MS = 15_000;
/** A crashed run blocks the next one at most this long past its deadline. */
const FLUSHER_LEASE_HEADROOM_MS = 5_000;
const FLUSHER_LOCK_TIMEOUT_MS = 100;
const FLUSHER_RELEASE_LOCK_TIMEOUT_MS = 1_000;
const MAX_BACKGROUND_PASSES = 32;
const QUEUE_BUSY_RETRY_MS = 250;
const OWNER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function getFlusherLeasePath(baseDir) {
    return path.join(resolveStateDir(baseDir), 'capture-flusher.json');
}
function validateFlusherLease(data) {
    const obj = data && typeof data === 'object' ? data : {};
    if (obj.version !== 1 || typeof obj.owner !== 'string' || typeof obj.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(obj.expiresAt))) {
        throw new Error('Unsupported capture flusher lease');
    }
    return { version: 1, owner: obj.owner, expiresAt: obj.expiresAt };
}
/** The current lease, or null when none is recorded or the file is unusable (a later claim replaces it). */
function readFlusherLease(baseDir) {
    try {
        return readSafeJson(getFlusherLeasePath(baseDir), validateFlusherLease);
    }
    catch {
        return null;
    }
}
/**
 * Claim the account's flusher lease for `owner`. A live lease held by another
 * owner, or a busy lease lock, means a delivery run is already active.
 */
export async function claimFlusherLease(baseDir, owner, durationMs = BACKGROUND_FLUSH_DEADLINE_MS + FLUSHER_LEASE_HEADROOM_MS, now = Date.now()) {
    try {
        return await withSessionLock('capture-flusher', () => {
            const current = readFlusherLease(baseDir);
            if (current && current.owner !== owner && Date.parse(current.expiresAt) > now)
                return false;
            const lease = { version: 1, owner, expiresAt: new Date(now + durationMs).toISOString() };
            writeAtomic0600(getFlusherLeasePath(baseDir), JSON.stringify(lease));
            return true;
        }, { baseDir, timeoutMs: FLUSHER_LOCK_TIMEOUT_MS });
    }
    catch (error) {
        if (error instanceof SessionLockTimeoutError)
            return false;
        throw error;
    }
}
/** Release the lease if `owner` still holds it. Failures are ignored: the lease expires on its own. */
export async function releaseFlusherLease(baseDir, owner) {
    try {
        await withSessionLock('capture-flusher', () => {
            if (readFlusherLease(baseDir)?.owner !== owner)
                return;
            const leasePath = getFlusherLeasePath(baseDir);
            assertNotSymlink(leasePath);
            fs.rmSync(leasePath, { force: true });
        }, { baseDir, timeoutMs: FLUSHER_RELEASE_LOCK_TIMEOUT_MS });
    }
    catch {
        // Best effort.
    }
}
/** An automatic item a background run still has to send: queued, unknown, or abandoned mid-send. */
function isWaitingAutomaticItem(item, now) {
    if (item.captureTrigger === 'manual')
        return false;
    if (item.status === 'pending' || item.status === 'delivery_unknown')
        return true;
    return item.status === 'sending' && !(item.deliveryLease && Date.parse(item.deliveryLease.expiresAt) > now);
}
/** When the next automatic item becomes deliverable (`now` when one is due), or null when none waits. */
export function nextAutomaticDeliveryAt(baseDir, now = Date.now()) {
    let earliest = null;
    for (const item of listQueueItems(baseDir)) {
        if (!isWaitingAutomaticItem(item, now))
            continue;
        const retryAt = item.nextRetryAt ? Date.parse(item.nextRetryAt) : now;
        const dueAt = Number.isFinite(retryAt) ? Math.max(retryAt, now) : now;
        if (earliest === null || dueAt < earliest)
            earliest = dueAt;
    }
    return earliest;
}
/**
 * Called from a hook after it has queued its own slice. Starts one detached
 * delivery process when an automatic item is due within a run's deadline and
 * no other run holds the lease. Local work only: the hook never waits on the
 * network. Returns whether a process was started.
 */
export async function startBackgroundCaptureFlush(options) {
    const now = options.now ?? Date.now();
    const dueAt = nextAutomaticDeliveryAt(options.baseDir, now);
    if (dueAt === null || dueAt - now > BACKGROUND_FLUSH_DEADLINE_MS - BACKGROUND_FLUSH_REQUEST_TIMEOUT_MS)
        return false;
    const owner = randomUUID();
    if (!(await claimFlusherLease(options.baseDir, owner, undefined, now)))
        return false;
    try {
        const child = (options.spawnProcess ?? spawn)(process.execPath, [options.runtimePath, BACKGROUND_FLUSH_ARG, `--owner=${owner}`], 
        // Its own process group and no stdio: it outlives the hook and the host
        // session, and the host's read of the hook output ends when the hook exits.
        { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => {
            void releaseFlusherLease(options.baseDir, owner);
        });
        child.unref();
    }
    catch (error) {
        await releaseFlusherLease(options.baseDir, owner);
        const errno = error?.code;
        logRuntimeEvent('warn', 'capture_background_flush_spawn_failed', { errno: typeof errno === 'string' ? errno : 'unknown' }, options.baseDir);
        return false;
    }
    logRuntimeEvent('info', 'capture_background_flush_started', {}, options.baseDir);
    return true;
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}
async function loadBackgroundClient(brainHome) {
    try {
        const { store } = await createDefaultCredentialStore({ baseDir: brainHome, warn: () => undefined });
        return new ApiClient({ store });
    }
    catch {
        return null;
    }
}
/**
 * The detached process: deliver due automatic items, wait out retry backoff
 * while the next retry still fits the deadline, then release the lease. Every
 * consent, authorization, and workspace check in `flushCaptureQueue` applies;
 * the starting hook already checked its project's capture policy.
 */
export async function runBackgroundCaptureFlush(options) {
    const stateDir = resolveStateDir(options.baseDir);
    const deadlineMs = options.deadlineMs ?? BACKGROUND_FLUSH_DEADLINE_MS;
    const requestTimeoutMs = Math.min(options.requestTimeoutMs ?? BACKGROUND_FLUSH_REQUEST_TIMEOUT_MS, deadlineMs);
    const summary = { stopReason: 'idle', passes: 0, sent: 0, failed: 0, unknown: 0, requests: 0 };
    // The starting hook claimed the lease for this owner; renewing it measures the lease from now.
    if (!(await claimFlusherLease(stateDir, options.owner, deadlineMs + FLUSHER_LEASE_HEADROOM_MS))) {
        summary.stopReason = 'busy';
        logRuntimeEvent('info', 'capture_background_flush', { ...summary }, stateDir);
        return summary;
    }
    const controller = new AbortController();
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
        // Another run may have delivered everything since the hook looked.
        if (nextAutomaticDeliveryAt(stateDir) === null)
            return summary;
        const apiClient = options.apiClient ?? await loadBackgroundClient(options.baseDir);
        if (!apiClient) {
            summary.stopReason = 'no_credentials';
            return summary;
        }
        while (true) {
            if (controller.signal.aborted) {
                summary.stopReason = 'deadline';
                break;
            }
            if (summary.passes >= MAX_BACKGROUND_PASSES) {
                summary.stopReason = 'pass_limit';
                break;
            }
            const pass = await flushCaptureQueue({
                apiClient,
                baseDir: stateDir,
                signal: controller.signal,
                allowAutomatic: true,
                requestTimeoutMs,
            });
            summary.passes += 1;
            summary.sent += pass.sent;
            summary.failed += pass.failed;
            summary.unknown += pass.unknown;
            summary.requests += pass.requests;
            if (pass.queueBusy) {
                await sleep(QUEUE_BUSY_RETRY_MS, controller.signal);
                continue;
            }
            // A pass that sent something re-checks at once; failures it recorded carry their own backoff.
            if (pass.requests > 0)
                continue;
            const now = Date.now();
            const dueAt = nextAutomaticDeliveryAt(stateDir, now);
            if (dueAt === null) {
                summary.stopReason = 'idle';
                break;
            }
            // Due now yet not sent: consent, the grant, or its workspaces rule it out for this run.
            if (dueAt <= now) {
                summary.stopReason = 'undeliverable';
                break;
            }
            if (dueAt + requestTimeoutMs > deadlineAt) {
                summary.stopReason = 'deadline';
                break;
            }
            await sleep(dueAt - now, controller.signal);
        }
        return summary;
    }
    finally {
        clearTimeout(timer);
        await releaseFlusherLease(stateDir, options.owner);
        logRuntimeEvent('info', 'capture_background_flush', { ...summary }, stateDir);
    }
}
/** Entry for `brainmcp-hook-runtime.mjs --flush-capture --owner=<uuid>`. Always exits 0. */
export async function runBackgroundFlushCli(args) {
    // Nothing in the run should outlive its deadline; this is the backstop.
    setTimeout(() => process.exit(0), BACKGROUND_FLUSH_DEADLINE_MS + 10_000).unref();
    const owner = args.find((arg) => arg.startsWith('--owner='))?.slice('--owner='.length) ?? '';
    try {
        if (OWNER_RE.test(owner))
            await runBackgroundCaptureFlush({ owner });
    }
    catch (error) {
        const errno = error?.code;
        logRuntimeEvent('warn', 'capture_background_flush_failed', {
            error: typeof errno === 'string' ? errno : error instanceof Error ? error.name : 'unknown',
        });
    }
    process.exitCode = 0;
}
//# sourceMappingURL=background-flush.js.map