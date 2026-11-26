import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getBrainHome, ensureDirectory0700, assertNotSymlink } from './storage.js';
const RUNTIME_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
export function normalizeRuntimeVersion(version) {
    const normalized = version.trim().replace(/^v/, '');
    if (!RUNTIME_VERSION_RE.test(normalized) || normalized.includes('..')) {
        throw new Error(`Invalid BrainMCP runtime version: ${version}`);
    }
    return normalized;
}
export function getRuntimesDir(baseDir, create = false) {
    const home = baseDir ?? getBrainHome();
    const runtimesDir = path.join(home, 'runtime');
    if (create)
        ensureDirectory0700(runtimesDir);
    return runtimesDir;
}
export function getVersionedRuntimeDir(version, baseDir, create = false) {
    const runtimesDir = getRuntimesDir(baseDir, create);
    const versionDir = path.join(runtimesDir, `v${normalizeRuntimeVersion(version)}`);
    if (create)
        ensureDirectory0700(versionDir);
    return versionDir;
}
export function getVersionedRuntimePath(version, baseDir) {
    const versionDir = getVersionedRuntimeDir(version, baseDir, false);
    return path.join(versionDir, 'brainmcp-hook-runtime.mjs');
}
/**
 * The version-independent runtime path every managed hook command runs:
 * `~/.brainmcp/runtime/brainmcp-hook-runtime.mjs`, a small shim that runs the
 * versioned runtime `init` installed last. A CLI upgrade then rewrites the shim
 * and leaves host hook configs byte-identical, which keeps Codex hook trust
 * (Codex hashes each hook's command and skips a changed one as "Modified").
 * It keeps the runtime's basename, so earlier removal and detection rules
 * recognize commands that name it.
 */
export function getRuntimeShimPath(baseDir) {
    return path.join(getRuntimesDir(baseDir), 'brainmcp-hook-runtime.mjs');
}
const RUNTIME_SHIM_MARKER = 'brainmcp:hook-runtime-shim';
/**
 * The shim for `version`. It imports the versioned bundle by a relative URL
 * (no absolute path to quote) and calls its exported entry, because the bundle
 * runs itself only when it is the main module. A missing or broken bundle
 * fails open with an empty answer, as the runtime does.
 */
export function renderRuntimeShim(version) {
    const target = `./v${normalizeRuntimeVersion(version)}/brainmcp-hook-runtime.mjs`;
    return [
        `// ${RUNTIME_SHIM_MARKER} v1, written by \`brainmcp init\`; init rewrites it.`,
        '// Managed hook commands run this file so they stay the same across CLI upgrades.',
        'let runtime;',
        'try {',
        `  runtime = await import(${JSON.stringify(target)});`,
        '} catch {',
        "  process.stdout.write('{}\\n');",
        '}',
        'if (runtime) await runtime.runHookRuntimeCli(process.argv.slice(2));',
        '',
    ].join('\n');
}
/** The runtime version a shim's text runs, or undefined when it is not a BrainMCP shim. */
export function runtimeShimTargetVersion(shimText) {
    if (!shimText?.includes(RUNTIME_SHIM_MARKER))
        return undefined;
    const version = shimText.match(/import\("\.\/v([0-9A-Za-z][0-9A-Za-z._-]{0,63})\/brainmcp-hook-runtime\.mjs"\)/)?.[1];
    return version && !version.includes('..') ? version : undefined;
}
/** The runtime version the installed shim runs, if a BrainMCP shim is installed. */
export function readRuntimeShimTarget(baseDir) {
    const shimPath = getRuntimeShimPath(baseDir);
    try {
        if (fs.lstatSync(shimPath).isSymbolicLink())
            return undefined;
        return runtimeShimTargetVersion(fs.readFileSync(shimPath, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Points the shim at an installed runtime version (atomic temp-file rename).
 * `init` writes the same text through its previewed, atomic file changes.
 */
export function installRuntimeShim(version, baseDir) {
    getRuntimesDir(baseDir, true);
    const shimPath = getRuntimeShimPath(baseDir);
    assertNotSymlink(shimPath);
    const tmpPath = `${shimPath}.tmp.${crypto.randomUUID()}`;
    try {
        fs.writeFileSync(tmpPath, renderRuntimeShim(version), { flag: 'wx', mode: 0o644 });
        fs.renameSync(tmpPath, shimPath);
    }
    catch (error) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch {
            // Best-effort cleanup.
        }
        throw error;
    }
    return shimPath;
}
/**
 * Installs runtime bundle atomically to ~/.brainmcp/runtime/v<version>/brainmcp-hook-runtime.mjs (AHI-052).
 */
export function installRuntimeBundle(version, bundleContent, baseDir) {
    const versionDir = getVersionedRuntimeDir(version, baseDir, true);
    const targetPath = path.join(versionDir, 'brainmcp-hook-runtime.mjs');
    assertNotSymlink(targetPath);
    const tmpPath = `${targetPath}.tmp.${crypto.randomUUID()}`;
    try {
        fs.writeFileSync(tmpPath, bundleContent, { flag: 'wx', mode: 0o755 });
        fs.renameSync(tmpPath, targetPath);
    }
    catch (error) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch {
            // Best-effort cleanup.
        }
        throw error;
    }
    return {
        version,
        runtimePath: targetPath,
        installedAt: new Date().toISOString(),
    };
}
/**
 * Lists all currently installed runtime versions.
 */
export function listInstalledRuntimes(baseDir) {
    const runtimesDir = getRuntimesDir(baseDir, false);
    if (!fs.existsSync(runtimesDir))
        return [];
    const entries = fs.readdirSync(runtimesDir);
    const runtimes = [];
    for (const entry of entries) {
        if (!entry.startsWith('v'))
            continue;
        const versionDir = path.join(runtimesDir, entry);
        const runtimePath = path.join(versionDir, 'brainmcp-hook-runtime.mjs');
        if (fs.existsSync(runtimePath)) {
            try {
                const stat = fs.lstatSync(runtimePath);
                if (!stat.isSymbolicLink()) {
                    runtimes.push({
                        version: entry.replace(/^v/, ''),
                        runtimePath,
                        installedAt: stat.mtime.toISOString(),
                    });
                }
            }
            catch {
                // Ignore
            }
        }
    }
    return runtimes;
}
/**
 * Removes an old runtime version, but BLOCKS removal if any known config references it (AHI-052).
 * Hook configs name the shim, so the version the shim runs counts as referenced too.
 */
export function removeRuntimeVersion(version, referencedPaths, baseDir) {
    if (readRuntimeShimTarget(baseDir) === normalizeRuntimeVersion(version)) {
        return {
            removed: false,
            blockedReason: `Runtime v${version} is still referenced: the managed hook shim runs it`,
        };
    }
    const targetPath = getVersionedRuntimePath(version, baseDir);
    const normalizedTarget = path.resolve(targetPath);
    // Check if any referenced path in host configs references this runtime
    const isReferenced = referencedPaths.some((ref) => {
        const normRef = path.resolve(ref);
        return normRef === normalizedTarget || normRef.includes(`/v${normalizeRuntimeVersion(version)}/`);
    });
    if (isReferenced) {
        return {
            removed: false,
            blockedReason: `Runtime v${version} is still referenced by an active host configuration`,
        };
    }
    const versionDir = getVersionedRuntimeDir(version, baseDir);
    if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
        return { removed: true };
    }
    return { removed: false, blockedReason: `Runtime v${version} does not exist` };
}
/**
 * Prunes unreferenced versioned runtime directories older than `maxAgeMs` beyond
 * the newest `keepLatest` installations. Always keeps the shim target and any
 * explicitly referenced path.
 */
export function pruneUnreferencedRuntimes(options) {
    const baseDir = options?.baseDir;
    const keepLatest = Math.max(1, options?.keepLatest ?? 2);
    const maxAgeMs = options?.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
    const now = options?.now ?? Date.now();
    const referencedPaths = options?.referencedPaths ?? [];
    const installed = listInstalledRuntimes(baseDir).sort((a, b) => Date.parse(b.installedAt) - Date.parse(a.installedAt));
    const removed = [];
    for (const runtime of installed.slice(keepLatest)) {
        const installedAtMs = Date.parse(runtime.installedAt);
        if (!Number.isFinite(installedAtMs) || now - installedAtMs <= maxAgeMs)
            continue;
        if (removeRuntimeVersion(runtime.version, referencedPaths, baseDir).removed) {
            removed.push(runtime.version);
        }
    }
    return removed;
}
// The version names the installed hook runtime directory, so an unreadable package.json must fail
// rather than report (and install under) a made-up version.
export function cliPackageVersion() {
    const require = createRequire(import.meta.url);
    const version = require('../../package.json').version;
    if (typeof version !== 'string' || !version) {
        throw new Error('The BrainMCP CLI package.json has no version. Reinstall the CLI.');
    }
    return version;
}
export function loadPackagedRuntimeBundle() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(here, 'brainmcp-hook-runtime.mjs'),
        path.join(here, '../../dist/runtime/brainmcp-hook-runtime.mjs'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return fs.readFileSync(candidate, 'utf8');
        }
    }
    return null;
}
//# sourceMappingURL=installer.js.map