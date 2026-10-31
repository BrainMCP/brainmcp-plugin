import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getBrainHome } from '../runtime/storage.js';
import { ensureBackupsDir, isCleanInGit, pruneBackups, writeBackup } from './backups.js';
export async function readText(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (isNotFound(error))
            return undefined;
        throw error;
    }
}
export async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve a target path against `root`. An absolute path (including a Windows
 * drive or UNC path) is kept as is; a leading `~/` or `~\` means `root`.
 * `pathApi` exists so tests can apply Windows rules on any platform.
 */
export function toAbsolute(root, path, pathApi = { resolve }) {
    return pathApi.resolve(root, path.replace(/^~[\\/]/, ''));
}
export function renderDiff(change) {
    const before = change.before?.split('\n') ?? [];
    const after = change.after?.split('\n') ?? [];
    const header = `--- ${change.before === undefined ? '/dev/null' : change.path}\n+++ ${change.after === undefined ? '/dev/null' : change.path}`;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start])
        start += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start &&
        afterEnd > start &&
        before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }
    const contextStart = Math.max(0, start - 2);
    const contextBeforeEnd = Math.min(before.length, beforeEnd + 2);
    const contextAfterEnd = Math.min(after.length, afterEnd + 2);
    const hunk = `@@ -${contextStart + 1},${contextBeforeEnd - contextStart} +${contextStart + 1},${contextAfterEnd - contextStart} @@`;
    return [
        header,
        hunk,
        ...before.slice(contextStart, start).map((line) => ` ${line}`),
        ...before.slice(start, beforeEnd).map((line) => `-${line}`),
        ...after.slice(start, afterEnd).map((line) => `+${line}`),
        ...after.slice(afterEnd, contextAfterEnd).map((line) => ` ${line}`),
    ].join('\n');
}
export async function applyChanges(changes, options = {}) {
    const brainHome = options.brainHome ?? getBrainHome();
    const now = options.now ?? Date.now;
    const isClean = options.isCleanInGit ?? ((path) => isCleanInGit(path));
    const prepared = [];
    // Validate the whole preview before touching any file. This prevents a long
    // confirmation prompt (or another client) from turning a reviewed diff into
    // an overwrite of newer configuration.
    for (const change of changes) {
        if (change.before === change.after)
            continue;
        const current = await readText(change.path);
        if (current !== change.before)
            throw changedSincePreview(change.path);
        let writePath = change.path;
        let existingMode;
        let symbolicLink = false;
        if (current !== undefined) {
            const metadata = await lstat(change.path);
            symbolicLink = metadata.isSymbolicLink();
            if (symbolicLink) {
                if (change.after === undefined) {
                    throw new Error(`Refusing to remove symlinked configuration ${change.path}; remove its managed block or target manually.`);
                }
                writePath = await realpath(change.path);
            }
            existingMode = (await stat(writePath)).mode & 0o777;
        }
        prepared.push({ change, writePath, existingMode, symbolicLink, backup: current !== undefined && change.backup !== false });
    }
    // A tracked file with no uncommitted change gets no copy: `git restore`
    // recovers exactly its current content. A tracked file with working-tree or
    // staged changes is backed up. The check follows a symlink to the file whose
    // content changes; any Git failure counts as not clean, so that file is backed up.
    const result = { backups: [], cleanInGit: [] };
    const clean = await Promise.all(prepared.map((item) => item.backup ? isClean(item.writePath) : Promise.resolve(false)));
    prepared.forEach((item, index) => {
        if (!clean[index])
            return;
        item.backup = false;
        result.cleanInGit.push(item.change.path);
    });
    // Create (or validate) the backups directory before any file changes, so an
    // unwritable or symlinked brain home fails the whole run with nothing changed.
    if (prepared.some((item) => item.backup))
        ensureBackupsDir(brainHome);
    for (const item of prepared) {
        const { change, writePath, existingMode, symbolicLink } = item;
        if ((await readText(change.path)) !== change.before)
            throw changedSincePreview(change.path);
        if (change.before !== undefined) {
            const currentMetadata = await lstat(change.path);
            if (currentMetadata.isSymbolicLink() !== symbolicLink)
                throw changedSincePreview(change.path);
            if (symbolicLink && (await realpath(change.path)) !== writePath)
                throw changedSincePreview(change.path);
        }
        await mkdir(dirname(writePath), { recursive: true });
        if (item.backup) {
            // Written before the original changes; a failure leaves it untouched.
            result.backups.push({ path: change.path, backup: writeBackup(change.path, await readFile(change.path), { brainHome, now: now() }) });
        }
        if (change.after === undefined) {
            await rm(change.path, { force: true });
            continue;
        }
        const temporary = `${writePath}.brainmcp-tmp-${randomUUID()}`;
        try {
            // Created with the original's mode (never wider, even before the chmod)
            // so a 0600 config holding tokens is never briefly world-readable; the
            // chmod restores mode bits the umask masked. A new file keeps the umask default.
            await writeFile(temporary, change.after, { encoding: 'utf8', mode: existingMode ?? 0o666, flag: 'wx' });
            if (existingMode !== undefined)
                await chmod(temporary, existingMode);
            await rename(temporary, writePath);
        }
        catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    }
    if (result.backups.length > 0) {
        try {
            pruneBackups({ brainHome, now: now() });
        }
        catch {
            // Retention is best effort; the files are already written. The SessionStart pass retries.
        }
    }
    return result;
}
function changedSincePreview(path) {
    return new Error(`Refusing to overwrite ${path}: it changed after the preview. Re-run the command and review the new diff.`);
}
function isNotFound(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
//# sourceMappingURL=files.js.map