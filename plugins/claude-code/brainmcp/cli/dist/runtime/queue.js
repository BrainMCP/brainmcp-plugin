import fs from 'node:fs';
import path from 'node:path';
import { QUEUE_SCHEMA_VERSION, validateQueueItemRecord, } from '../lib/cli-contracts.js';
import { ensureDirectory0700, writeAtomic0600, readSafeJson, assertNotSymlink, resolveStateDir, } from './storage.js';
export function getQueueDir(baseDir) {
    const queueDir = path.join(resolveStateDir(baseDir), 'queue');
    ensureDirectory0700(queueDir);
    return queueDir;
}
export function getQueueItemPath(digestId, baseDir) {
    const queueDir = getQueueDir(baseDir);
    const safeId = digestId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(queueDir, `${safeId}.json`);
}
export function enqueueCaptureItem(item, baseDir) {
    const now = new Date().toISOString();
    const record = {
        version: QUEUE_SCHEMA_VERSION,
        digestId: item.digestId,
        workspaceId: item.workspaceId,
        captureTrigger: item.captureTrigger,
        policyVersion: item.policyVersion,
        digestText: item.digestText,
        authorizationId: item.authorizationId,
        consentRevision: item.consentRevision,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
    };
    const filePath = getQueueItemPath(record.digestId, baseDir);
    writeAtomic0600(filePath, JSON.stringify(record, null, 2));
    return record;
}
export function listQueueItems(baseDir) {
    const queueDir = getQueueDir(baseDir);
    const entries = fs.readdirSync(queueDir);
    const items = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        const filePath = path.join(queueDir, entry);
        try {
            assertNotSymlink(filePath);
            const item = readSafeJson(filePath, validateQueueItemRecord);
            if (item) {
                items.push(item);
            }
        }
        catch {
            // Corrupted items skipped in listing
        }
    }
    // Sort by createdAt ascending
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function updateQueueItem(digestId, updates, baseDir) {
    const filePath = getQueueItemPath(digestId, baseDir);
    const existing = readSafeJson(filePath, validateQueueItemRecord);
    if (!existing) {
        return null;
    }
    const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
    };
    writeAtomic0600(filePath, JSON.stringify(updated, null, 2));
    return updated;
}
export function removeQueueItem(digestId, baseDir) {
    const filePath = getQueueItemPath(digestId, baseDir);
    if (fs.existsSync(filePath)) {
        assertNotSymlink(filePath);
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}
//# sourceMappingURL=queue.js.map