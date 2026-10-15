import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseJsonWithoutEcho, validatePreferencesRecord } from '../lib/cli-contracts.js';
export const CURRENT_ACCOUNT_SCHEMA_VERSION = 1;
export const SERVICE_ACCOUNT_ID = 'service';
export const ACCOUNTS_DIR_NAME = 'accounts';
export const CURRENT_ACCOUNT_FILENAME = 'current.json';
const LEGACY_STATE_NAMES = [
    'preferences.json',
    'credentials.json',
    'credentials.lock',
    'credentials.backend.json',
    'capture-status.json',
    'queue',
    'sessions',
    'cache',
    'locks',
    'logs',
];
export function getBrainHome() {
    const override = process.env.BRAINMCP_HOME ?? process.env.BRAIN_HOME;
    if (override) {
        return path.resolve(override);
    }
    return path.join(os.homedir(), '.brainmcp');
}
export function sanitizeAccountId(accountId) {
    const trimmed = accountId.trim();
    if (!trimmed) {
        throw new Error('Account id is required');
    }
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed) && !trimmed.includes('..')) {
        return trimmed;
    }
    const digest = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
    return `id-${digest}`;
}
export function getCurrentAccountPath(brainHome) {
    return path.join(brainHome ?? getBrainHome(), CURRENT_ACCOUNT_FILENAME);
}
export function validateCurrentAccountRecord(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Current account pointer must be an object');
    }
    const obj = data;
    if (obj.version !== CURRENT_ACCOUNT_SCHEMA_VERSION) {
        throw new Error(`Unsupported current-account schema version: ${String(obj.version)}`);
    }
    if (typeof obj.accountId !== 'string' || !obj.accountId.trim()) {
        throw new Error('Current account pointer requires accountId');
    }
    return {
        version: CURRENT_ACCOUNT_SCHEMA_VERSION,
        accountId: sanitizeAccountId(obj.accountId),
        updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    };
}
export function getCurrentAccountId(brainHome) {
    const record = readSafeJson(getCurrentAccountPath(brainHome), validateCurrentAccountRecord);
    return record?.accountId ?? null;
}
export function getAccountStateDir(brainHome, accountId) {
    const home = path.resolve(brainHome);
    const id = sanitizeAccountId(accountId);
    return path.join(home, ACCOUNTS_DIR_NAME, id);
}
/**
 * Per-account state directory when `current.json` is present.
 * Without a current account, callers keep using the brain home (legacy layout and tests).
 */
export function resolveStateDir(brainHome) {
    const home = brainHome ?? getBrainHome();
    const accountId = getCurrentAccountId(home);
    if (!accountId)
        return home;
    const accountsDir = path.join(path.resolve(home), ACCOUNTS_DIR_NAME);
    ensureDirectory0700(accountsDir);
    const dir = getAccountStateDir(home, accountId);
    ensureDirectory0700(dir);
    return dir;
}
export function switchCurrentAccount(brainHome, accountId) {
    const home = path.resolve(brainHome);
    ensureDirectory0700(home);
    const id = sanitizeAccountId(accountId);
    const accountsDir = path.join(home, ACCOUNTS_DIR_NAME);
    ensureDirectory0700(accountsDir);
    const stateDir = getAccountStateDir(home, id);
    ensureDirectory0700(stateDir);
    writeAtomic0600(getCurrentAccountPath(home), JSON.stringify({
        version: CURRENT_ACCOUNT_SCHEMA_VERSION,
        accountId: id,
        updatedAt: new Date().toISOString(),
    }, null, 2));
    return stateDir;
}
export function clearCurrentAccount(brainHome) {
    const currentPath = getCurrentAccountPath(brainHome);
    if (!fs.existsSync(currentPath))
        return;
    assertNotSymlink(currentPath);
    fs.unlinkSync(currentPath);
}
export function migrateLegacyFlatState(brainHome, accountId) {
    const home = path.resolve(brainHome);
    const dest = getAccountStateDir(home, accountId);
    ensureDirectory0700(path.join(home, ACCOUNTS_DIR_NAME));
    ensureDirectory0700(dest);
    const migrated = [];
    for (const name of LEGACY_STATE_NAMES) {
        const from = path.join(home, name);
        const to = path.join(dest, name);
        if (!fs.existsSync(from) || fs.existsSync(to))
            continue;
        assertNotSymlink(from);
        fs.renameSync(from, to);
        migrated.push(name);
    }
    return migrated;
}
export function activateAccount(brainHome, accountId) {
    const migratedInto = switchCurrentAccount(brainHome, accountId);
    migrateLegacyFlatState(brainHome, accountId);
    return migratedInto;
}
export function ensureDirectory0700(dirPath) {
    const resolved = path.resolve(dirPath);
    if (fs.existsSync(resolved)) {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink()) {
            throw new Error(`Security violation: directory ${resolved} is a symbolic link`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Path ${resolved} is not a directory`);
        }
        if (process.platform !== 'win32') {
            const mode = stat.mode & 0o777;
            if (mode !== 0o700) {
                fs.chmodSync(resolved, 0o700);
            }
        }
        return;
    }
    let existingParent = path.dirname(resolved);
    while (!fs.existsSync(existingParent)) {
        const next = path.dirname(existingParent);
        if (next === existingParent)
            break;
        existingParent = next;
    }
    if (fs.existsSync(existingParent) && fs.lstatSync(existingParent).isSymbolicLink()) {
        throw new Error(`Security violation: directory parent ${existingParent} is a symbolic link`);
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
}
export function assertNotSymlink(targetPath) {
    const resolved = path.resolve(targetPath);
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
        throw new Error(`Security violation: ${resolved} is a symbolic link`);
    }
}
export function writeAtomic0600(filePath, content) {
    const resolved = path.resolve(filePath);
    const dir = path.dirname(resolved);
    ensureDirectory0700(dir);
    assertNotSymlink(resolved);
    const tmpPath = `${resolved}.tmp.${crypto.randomUUID()}`;
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    try {
        const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
        try {
            fs.writeSync(fd, content, 0, 'utf8');
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        // Rename atomically
        fs.renameSync(tmpPath, resolved);
    }
    catch (error) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch {
            // Best-effort cleanup of an uncommitted temporary file.
        }
        throw error;
    }
    if (process.platform !== 'win32') {
        fs.chmodSync(resolved, 0o600);
    }
}
export function readSafeJson(filePath, validator) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        return null;
    }
    assertNotSymlink(resolved);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile()) {
        throw new Error(`Security violation: ${resolved} is not a regular file`);
    }
    if (process.platform !== 'win32') {
        const mode = stat.mode & 0o777;
        if (mode !== 0o600) {
            throw new Error(`Security violation: ${resolved} permissions are ${mode.toString(8)}, expected 600`);
        }
        if (process.getuid && stat.uid !== process.getuid()) {
            throw new Error(`Security violation: ${resolved} is not owned by the current user`);
        }
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    try {
        // Never JSON.parse directly here: V8's SyntaxError quotes the input, and these
        // files hold credentials, prompts, and digests.
        const parsed = parseJsonWithoutEcho(raw, 'file');
        if (validator) {
            return validator(parsed);
        }
        return parsed;
    }
    catch (err) {
        throw new Error(`Corrupt or invalid JSON in ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function getPreferencesPath(baseDir) {
    return path.join(resolveStateDir(baseDir), 'preferences.json');
}
export function readPreferences(baseDir) {
    return readSafeJson(getPreferencesPath(baseDir), validatePreferencesRecord);
}
export function writePreferences(prefs, baseDir) {
    writeAtomic0600(getPreferencesPath(baseDir), JSON.stringify(prefs, null, 2));
}
//# sourceMappingURL=storage.js.map