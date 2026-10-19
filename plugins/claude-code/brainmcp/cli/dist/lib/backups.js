import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory0700, getBrainHome, writeAtomic0600 } from '../runtime/storage.js';
/**
 * Backups of configuration files the CLI changes (decision L10, 0.1.40).
 *
 * Through 0.1.38 every changed file got a `<file>.brainmcp.bak-<ms>-<hash>`
 * copy beside it, never pruned, including inside users' Git repositories. Now:
 * - a file Git tracks with no uncommitted change (working tree and index match
 *   HEAD) gets no copy, since `git restore` recovers it; a tracked file with
 *   changes, or one marked skip-worktree or assume-unchanged, is backed up like
 *   any other;
 * - every other copy lives under `<brain home>/backups/<sha256 of the original
 *   absolute path>/`, beside a `manifest.json` that names the original path,
 *   with 0700 directories and 0600 files;
 * - copies older than 30 days, and all but the 10 newest per original file, are
 *   pruned whenever a new backup is written and by the SessionStart retention pass.
 * Legacy `.brainmcp.bak-*` files are never deleted; `doctor` points them out.
 */
export const BACKUPS_DIR_NAME = 'backups';
export const BACKUP_MANIFEST_NAME = 'manifest.json';
export const BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const BACKUP_MAX_PER_FILE = 10;
/** The marker in a pre-0.1.40 backup name: `<file>.brainmcp.bak-<ms>-<hash>`. */
export const LEGACY_BACKUP_MARKER = '.brainmcp.bak-';
const BACKUP_MANIFEST_VERSION = 1;
const ORIGINAL_DIR_PATTERN = /^[0-9a-f]{64}$/;
// `<epoch ms>-<8 hex>-<sanitized original basename>.bak`: the suffix keeps a copy
// of `CLAUDE.md` or `mcp.json` from passing for a live file in any tool that scans by extension.
const BACKUP_FILE_PATTERN = /^(\d{13,})-[0-9a-f]{8}-[A-Za-z0-9._-]{0,80}\.bak$/;
const GIT_CHECK_TIMEOUT_MS = 3_000;
export function getBackupsDir(brainHome = getBrainHome()) {
    return path.join(path.resolve(brainHome), BACKUPS_DIR_NAME);
}
/**
 * Create the backups directory (0700) if needed and check that it is a real,
 * writable directory. Throws otherwise: a symlinked directory or parent, a
 * file in its place, or an unwritable brain home.
 */
export function ensureBackupsDir(brainHome = getBrainHome()) {
    const dir = getBackupsDir(brainHome);
    ensureDirectory0700(dir);
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return dir;
}
/** The directory holding every backup of one original file: a hash of its absolute path. */
export function backupDirFor(originalPath, brainHome = getBrainHome()) {
    const digest = crypto.createHash('sha256').update(path.resolve(originalPath)).digest('hex');
    return path.join(getBackupsDir(brainHome), digest);
}
// Repository-local configuration must not run commands while the CLI only
// asks Git about a file: an fsmonitor hook would run on `status`, and no
// command here should run hooks. (Windows has no /dev/null; these read-only
// commands run no hooks there either.)
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', ...(process.platform === 'win32' ? [] : ['-c', 'core.hooksPath=/dev/null'])];
/**
 * Whether Git tracks `filePath` and it is clean: what is on disk now is
 * exactly the HEAD blob and the index matches HEAD, so `git restore` brings
 * the current content back. Read-only calls:
 * - `ls-files -v -s --error-unmatch` (an ignored file is tracked by nothing,
 *   and `status` would also print nothing for it) must show one stage-0 `H`
 *   entry: a skip-worktree (`S`) or assume-unchanged (lowercase) entry hides
 *   local edits from `status`, so it is never clean;
 * - `status --porcelain --untracked-files=no` must be empty (index and working
 *   tree match HEAD; a file added but never committed shows `A`);
 * - `hash-object --path` of the file (with the repository's filters and line
 *   endings applied) must equal the HEAD blob from `ls-tree HEAD`, and so must
 *   the index entry, so nothing Git skips comparing can pass for clean.
 * `--no-optional-locks` never takes `index.lock`; `--literal-pathspecs` keeps a
 * name with `*` or `:` from matching other files; fsmonitor and hooks are off
 * (GIT_SAFE_CONFIG). Inherited `GIT_DIR` and friends are dropped so the file's
 * own repository answers. Any failure (no Git, not a repository, untracked,
 * unborn HEAD, timeout) means "not clean", so the caller backs the file up.
 */
export async function isCleanInGit(filePath, options = {}) {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'])
        delete env[key];
    const deadline = Date.now() + (options.timeoutMs ?? GIT_CHECK_TIMEOUT_MS);
    const name = path.basename(filePath);
    const git = (args) => new Promise((resolve) => {
        const timeout = deadline - Date.now();
        if (timeout <= 0)
            return resolve(undefined);
        try {
            execFile(options.gitBinary ?? 'git', [...GIT_SAFE_CONFIG, '--no-optional-locks', '--literal-pathspecs', '-C', path.dirname(filePath), ...args, '--', name], { env, timeout, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error === null ? stdout : undefined)).stdin?.end();
        }
        catch {
            resolve(undefined);
        }
    });
    const entry = await git(['ls-files', '-v', '-s', '--error-unmatch']);
    const indexBlob = entry === undefined || entry.trimEnd().includes('\n') ? undefined : /^H \d{6} ([0-9a-f]{40,64}) 0\t/.exec(entry)?.[1];
    if (indexBlob === undefined)
        return false;
    const [status, head, onDisk] = await Promise.all([
        git(['status', '--porcelain=v1', '--untracked-files=no']),
        git(['ls-tree', 'HEAD']),
        git(['hash-object', `--path=${name}`]),
    ]);
    const headBlob = head === undefined || head.trimEnd().includes('\n') ? undefined : /^\d{6} blob ([0-9a-f]{40,64})\t/.exec(head)?.[1];
    return status !== undefined && status.trim() === '' && headBlob !== undefined && headBlob === indexBlob && onDisk?.trim() === headBlob;
}
/**
 * Save `content` (the original file's current bytes) as a new backup of
 * `originalPath` and return the backup's path. Throws if it cannot be written,
 * so the caller leaves the original untouched.
 *
 * The copy is written before the manifest, and the manifest is (re)written
 * after it, so a concurrent `pruneBackups` that is removing this set as empty
 * either sees the copy (and keeps the manifest) or has finished before the
 * manifest is written again. If that prune removed the directory between our
 * mkdir and the copy, the directory is created once more.
 */
export function writeBackup(originalPath, content, options = {}) {
    const original = path.resolve(originalPath);
    const brainHome = options.brainHome ?? getBrainHome();
    const dir = backupDirFor(original, brainHome);
    const now = options.now ?? Date.now();
    const name = `${String(Math.max(0, Math.floor(now))).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}-${sanitizeBasename(path.basename(original))}.bak`;
    const backupPath = path.join(dir, name);
    for (let attempt = 0;; attempt += 1) {
        ensureBackupsDir(brainHome);
        ensureDirectory0700(dir);
        try {
            // `wx` refuses an existing path, a symlink included.
            fs.writeFileSync(backupPath, content, { mode: 0o600, flag: 'wx' });
            break;
        }
        catch (error) {
            if (attempt === 0 && error.code === 'ENOENT')
                continue;
            throw error;
        }
    }
    if (process.platform !== 'win32')
        fs.chmodSync(backupPath, 0o600);
    // Rewritten every time: its content is fixed by the directory name, and an
    // unreadable, tampered, or concurrently pruned manifest is simply replaced.
    writeAtomic0600(path.join(dir, BACKUP_MANIFEST_NAME), `${JSON.stringify({ version: BACKUP_MANIFEST_VERSION, originalPath: original }, null, 2)}\n`);
    return backupPath;
}
/** Every backup set under the backups directory. Symlinks and unrecognized entries are ignored. */
export function listBackupSets(brainHome = getBrainHome()) {
    const root = getBackupsDir(brainHome);
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!rootStat?.isDirectory())
        return [];
    const sets = [];
    for (const entry of fs.readdirSync(root)) {
        if (!ORIGINAL_DIR_PATTERN.test(entry))
            continue;
        const dir = path.join(root, entry);
        const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (!stat?.isDirectory())
            continue;
        const backups = [];
        for (const name of fs.readdirSync(dir)) {
            const match = BACKUP_FILE_PATTERN.exec(name);
            if (!match)
                continue;
            const filePath = path.join(dir, name);
            const fileStat = fs.lstatSync(filePath, { throwIfNoEntry: false });
            if (!fileStat?.isFile())
                continue;
            backups.push({ path: filePath, createdAt: Number(match[1]) });
        }
        backups.sort((a, b) => b.createdAt - a.createdAt || (a.path < b.path ? 1 : -1));
        sets.push({ originalPath: readManifestPath(path.join(dir, BACKUP_MANIFEST_NAME)), dir, backups });
    }
    return sets;
}
/**
 * Delete backups older than `maxAgeMs` and all but the `maxPerFile` newest of
 * each original file; a set left empty loses its manifest and directory.
 * Only files this module names are touched. Returns how many backups it deleted.
 */
export function pruneBackups(options = {}) {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? BACKUP_MAX_AGE_MS;
    const maxPerFile = options.maxPerFile ?? BACKUP_MAX_PER_FILE;
    let pruned = 0;
    for (const set of listBackupSets(options.brainHome)) {
        let kept = 0;
        set.backups.forEach((backup, index) => {
            if (index < maxPerFile && now - backup.createdAt <= maxAgeMs) {
                kept += 1;
                return;
            }
            try {
                fs.unlinkSync(backup.path);
                pruned += 1;
            }
            catch {
                kept += 1; // Still there (or a concurrent prune took it); the next pass retries.
            }
        });
        if (kept > 0)
            continue;
        options.beforeRemoveEmptySet?.(set.dir);
        removeEmptySet(set.dir);
    }
    return pruned;
}
/**
 * Remove a set this pass emptied: its manifest, then its directory. A
 * concurrent `writeBackup` may be adding a copy, so the manifest is first
 * renamed aside (claimed), the directory is checked again for copies, and the
 * manifest is put back when one appeared. `writeBackup` writes its copy before
 * its manifest, so a copy written after this check comes with a fresh manifest.
 */
function removeEmptySet(dir) {
    const manifest = path.join(dir, BACKUP_MANIFEST_NAME);
    let claimed;
    try {
        if (fs.lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
            claimed = path.join(dir, `.${BACKUP_MANIFEST_NAME}.prune-${crypto.randomBytes(4).toString('hex')}`);
            fs.renameSync(manifest, claimed);
        }
    }
    catch {
        return; // Gone already, or not ours to move: leave the set for the next pass.
    }
    if (claimed !== undefined) {
        try {
            if (fs.readdirSync(dir).some((name) => BACKUP_FILE_PATTERN.test(name))) {
                // A copy arrived: keep the set. The manifest's content is fixed by the
                // directory name, so replacing one the writer just wrote changes nothing.
                fs.renameSync(claimed, manifest);
                return;
            }
            fs.unlinkSync(claimed);
        }
        catch {
            return; // The next pass retries.
        }
    }
    rmdirQuietly(dir);
}
function rmdirQuietly(dir) {
    try {
        fs.rmdirSync(dir); // Fails, harmlessly, when something else is inside.
    }
    catch {
        // Ignore
    }
}
/** Pre-0.1.40 `<file>.brainmcp.bak-*` copies beside each of `files`. Never deletes anything. */
export async function findLegacyBackups(files) {
    const found = new Set();
    for (const file of new Set(files.filter((value) => Boolean(value)).map((value) => path.resolve(value)))) {
        const prefix = `${path.basename(file)}${LEGACY_BACKUP_MARKER}`;
        let names;
        try {
            names = await readdir(path.dirname(file));
        }
        catch {
            continue;
        }
        for (const name of names)
            if (name.startsWith(prefix))
                found.add(path.join(path.dirname(file), name));
    }
    return [...found].sort();
}
function sanitizeBasename(name) {
    return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}
function readManifestPath(manifestPath) {
    try {
        const stat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
        if (!stat?.isFile())
            return undefined;
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return parsed?.version === BACKUP_MANIFEST_VERSION && typeof parsed.originalPath === 'string' ? parsed.originalPath : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=backups.js.map