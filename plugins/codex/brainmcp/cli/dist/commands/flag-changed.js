import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiClient } from '../lib/api-client.js';
import { CliConfigurationError } from '../lib/cli-contracts.js';
import { createDefaultCredentialStore, MemoryCredentialStore } from '../lib/credentials.js';
/**
 * `brainmcp flag-changed`: tell brain which files a commit changed, so notes
 * linking to them (`source.path`) go stale until someone edits or confirms them.
 * Meant for CI, where a stored sign-in does not exist, so it authenticates only
 * with a service connection that holds the `kb:source_changes` scope.
 */
const SOURCE_CHANGES_PATH = '/v1/kb/source-changes';
/** The API's `SOURCE_CHANGE_MAX_PATHS`, and well under its 256 KiB body limit. */
const MAX_PATHS_PER_REQUEST = 500;
const MAX_BYTES_PER_REQUEST = 200 * 1024;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
/** The same guard as the capture's Git calls (runtime/capture.ts): no fsmonitor, no hooks. */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', ...(process.platform === 'win32' ? [] : ['-c', 'core.hooksPath=/dev/null'])];
const runGit = async (args, cwd) => {
    const { stdout } = await promisify(execFile)('git', [...GIT_SAFE_CONFIG, ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
};
const GIT_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
/** `git diff --name-only` without `-z` C-quotes a path holding special or non-ASCII characters. */
export function unquoteGitPath(line) {
    if (line.length < 2 || !line.startsWith('"') || !line.endsWith('"'))
        return line;
    const input = Buffer.from(line.slice(1, -1), 'utf8');
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
        const byte = input[index];
        if (byte !== 92 || index + 1 >= input.length) {
            output.push(byte);
            continue;
        }
        const next = String.fromCharCode(input[index + 1]);
        const octal = input.subarray(index + 1, index + 4).toString('latin1');
        if (/^[0-7]{3}$/.test(octal)) {
            output.push(Number.parseInt(octal, 8));
            index += 3;
        }
        else {
            output.push(GIT_ESCAPES[next] ?? input[index + 1]);
            index += 1;
        }
    }
    return Buffer.from(output).toString('utf8');
}
/** One path per line, or NUL-separated (`git diff -z`), each path once. */
export function parseChangedPaths(text) {
    const paths = text.includes('\0')
        ? text.split('\0')
        : text.split(/\r?\n/).map(unquoteGitPath);
    return [...new Set(paths.filter((path) => path.trim() !== ''))];
}
/**
 * Requests that each fit the API's limits, in order. A path is measured as the request carries it: JSON escapes a
 * quote or backslash to two bytes and a control character to six, plus its comma. The rest of the body (the commit
 * and a paging cursor, both capped by the API) fits in the room left under the 256 KiB limit.
 */
export function batchChangedPaths(paths) {
    const batches = [];
    let current = [];
    let bytes = 0;
    for (const path of paths) {
        const size = Buffer.byteLength(JSON.stringify(path), 'utf8') + 1;
        if (current.length >= MAX_PATHS_PER_REQUEST || (current.length > 0 && bytes + size > MAX_BYTES_PER_REQUEST)) {
            batches.push(current);
            current = [];
            bytes = 0;
        }
        current.push(path);
        bytes += size;
    }
    if (current.length > 0)
        batches.push(current);
    return batches;
}
async function readAllStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}
async function changesFromGit(options) {
    const git = options.runGit ?? runGit;
    const base = options.base ?? 'HEAD~1';
    const head = options.head ?? 'HEAD';
    try {
        // --no-renames: a moved file also lists its old path, which is the one a note still links to.
        const output = await git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', base, head], options.cwd);
        const commit = options.commit ?? (await git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`], options.cwd)).trim();
        return { commit, paths: parseChangedPaths(output) };
    }
    catch (error) {
        throw new CliConfigurationError(`git diff ${base} ${head} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}. `
            + 'Run this inside the repository, with both commits fetched. A shallow CI clone needs fetch-depth 2 or more, or pipe your own diff with --stdin.');
    }
}
async function resolveServiceToken(options) {
    const fromEnvironment = (options.serviceToken ?? process.env.BRAINMCP_SERVICE_TOKEN)?.trim();
    if (fromEnvironment)
        return fromEnvironment;
    const store = options.store ?? (await createDefaultCredentialStore({ allowFileCredentials: true, baseDir: options.runtimeHome })).store;
    const stored = await store.get();
    if (stored?.authType === 'service' && stored.serviceToken)
        return stored.serviceToken;
    throw Object.assign(new Error('flag-changed needs a service connection. Set BRAINMCP_SERVICE_TOKEN to one with the kb:source_changes scope (Settings > API access).'), { status: 401 });
}
/** Pages one batch of paths may take: 20 of 500 notes. A match larger still is reported as truncated. */
const FLAG_MAX_PAGES_PER_BATCH = 20;
/**
 * A rate-limited request is retried after its `Retry-After`, a few times and never waiting
 * longer than a minute each, so a large diff finishes in one CI run instead of stopping halfway.
 */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_SECONDS = 60;
const RATE_LIMIT_DEFAULT_WAIT_SECONDS = 10;
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function flagChanged(options) {
    const { commit, paths } = options.fromStdin
        ? { commit: options.commit, paths: parseChangedPaths(await (options.readStdin ?? readAllStdin)()) }
        : await changesFromGit(options);
    const token = paths.length > 0 ? await resolveServiceToken(options) : undefined;
    const apiClient = options.apiClient ?? new ApiClient({ store: options.store ?? new MemoryCredentialStore() });
    const flagged = new Map();
    let ignoredPaths = 0;
    let truncated = false;
    let workspaceId;
    const sleep = options.sleep ?? sleepFor;
    const send = async (body) => {
        for (let attempt = 0;; attempt += 1) {
            try {
                return await apiClient.request(SOURCE_CHANGES_PATH, {
                    body,
                    // The route takes only a service credential, whatever else this machine has signed in with.
                    headers: { Authorization: `Bearer ${token}` },
                    method: 'POST',
                });
            }
            catch (error) {
                const { retryAfterSeconds, status } = (error ?? {});
                if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
                    // At least a second, so a `Retry-After: 0` cannot spend the retries at once.
                    const wait = Math.max(1, Math.min(retryAfterSeconds ?? RATE_LIMIT_DEFAULT_WAIT_SECONDS, RATE_LIMIT_MAX_WAIT_SECONDS));
                    await sleep(wait * 1000);
                    continue;
                }
                if (status !== 403)
                    throw error;
                throw Object.assign(new Error('The service connection may not flag notes: give it the kb:source_changes scope in Settings > API access.'), { status });
            }
        }
    };
    // Paths whose every page was answered, in the order sent: what a stopped run had finished.
    let pathsDone = 0;
    let after;
    const report = (stopped) => {
        const nodes = [...flagged.values()];
        return {
            changedPaths: paths.length,
            commit: commit ?? null,
            dryRun: options.dryRun,
            flagged: nodes,
            flaggedCount: nodes.length,
            ignoredPaths,
            truncated,
            workspaceId: workspaceId ?? null,
            ...(stopped === undefined ? {} : {
                // What a stopped run did is kept: notes it flagged stay flagged, and a re-run with the same
                // commit skips them. Without a commit a re-run flags them again.
                stopped: {
                    error: stopped instanceof Error ? stopped.message : String(stopped),
                    nextAfter: after ?? null,
                    pathsDone,
                    status: stopped?.status ?? null,
                },
            }),
        };
    };
    try {
        for (const batch of batchChangedPaths(paths)) {
            // A truncated answer names where the next starts, so a large match is flagged in one run, commit or not.
            after = undefined;
            let batchTruncated = false;
            for (let page = 0; page < FLAG_MAX_PAGES_PER_BATCH; page += 1) {
                const response = await send({ paths: batch, ...(commit ? { commit } : {}), ...(options.dryRun ? { dryRun: true } : {}), ...(after ? { after } : {}) });
                for (const node of response.flagged)
                    flagged.set(node.id, node);
                if (page === 0)
                    ignoredPaths += response.ignoredPaths;
                workspaceId = response.workspaceId;
                batchTruncated = response.truncated;
                // An API without paging answers no nextAfter: what is left needs a re-run with the same commit.
                if (!response.truncated || !response.nextAfter)
                    break;
                after = response.nextAfter;
            }
            truncated ||= batchTruncated;
            pathsDone += batch.length;
            after = undefined;
        }
    }
    catch (error) {
        // CI keeps what this run did: the report, then the same failure and exit code as before.
        if (options.json)
            options.output(JSON.stringify(report(error), null, 2));
        else if (flagged.size > 0) {
            options.output(`Stopped after ${pathsDone} of ${paths.length} changed files, having ${options.dryRun ? 'matched' : 'flagged'} ${flagged.size} ${flagged.size === 1 ? 'note' : 'notes'}:`);
            for (const node of flagged.values())
                options.output(`  ${node.path}: ${node.title} (${node.id})`);
        }
        throw error;
    }
    const nodes = [...flagged.values()];
    if (options.json) {
        options.output(JSON.stringify(report(), null, 2));
        return;
    }
    const changed = `${paths.length} changed ${paths.length === 1 ? 'file' : 'files'}`;
    if (nodes.length === 0) {
        options.output(paths.length === 0 ? 'No changed files.' : `No notes to flag for ${changed}.`);
    }
    else {
        options.output(`${options.dryRun ? 'Would flag' : 'Flagged'} ${nodes.length} ${nodes.length === 1 ? 'note' : 'notes'} for review from ${changed}:`);
        for (const node of nodes)
            options.output(`  ${node.path}: ${node.title} (${node.id})`);
    }
    if (truncated)
        options.output('More notes matched than this run flags. Run this again with the same commit for the rest.');
}
//# sourceMappingURL=flag-changed.js.map