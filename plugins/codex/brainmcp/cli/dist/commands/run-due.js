import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildRunDuePrompt } from '../agent-config.js';
import { apiPathSegment } from '../api-client.js';
import { ApiClient } from '../lib/api-client.js';
import { CLI_EXIT_CODES, CliConfigurationError, UNATTENDED_RUN_ENV } from '../lib/cli-contracts.js';
import { createDefaultCredentialStore } from '../lib/credentials.js';
import { COMPANION_WORKSPACES_PATH } from '../lib/endpoints.js';
import { isProcessAlive, removeLockIfStill } from '../runtime/lock.js';
import { readProjectWorkspaceId, resolveOrientWorkspaceId } from '../runtime/orient.js';
import { assertNotSymlink, ensureDirectory0700, resolveStateDir } from '../runtime/storage.js';
/**
 * `brainmcp run-due`: what a person's cron or CI calls so due work runs without
 * anyone starting a session. It checks for due work, and only when there is some
 * launches the command the person named. Brain runs no model here or on the
 * server: the agent, its sign-in to Brain, and its token spend are all theirs.
 * The check costs one API read, so a schedule with nothing due spends no tokens.
 */
/** Stands for the prompt in an agent command that takes it as an argument. */
export const RUN_DUE_PROMPT_PLACEHOLDER = '{prompt}';
export const RUN_DUE_DEFAULT_TIMEOUT_MINUTES = 30;
export const RUN_DUE_MAX_TIMEOUT_MINUTES = 24 * 60;
/** How long a stopped agent gets to exit before it is killed. */
const AGENT_STOP_GRACE_MS = 10_000;
/** `/orient` takes seconds on a cold start, and nothing here races a hook's budget. */
const DUE_READ_TIMEOUT_MS = 30_000;
const STALE_UNREADABLE_LOCK_MS = 5_000;
function signInRequired(message) {
    return Object.assign(new Error(message), { status: 401 });
}
function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
}
export function describeDueWork(work) {
    const parts = `${plural(work.dueWorkflowCount, 'task', 'tasks')} due, ${plural(work.pendingDigestCount, 'digest', 'digests')} waiting`;
    const expiring = work.expiringDigests
        ? ` (${plural(work.expiringDigests.count, 'imported digest is', 'imported digests are')} deleted unprocessed starting ${work.expiringDigests.soonestExpiresAt.slice(0, 10)})`
        : '';
    return `${parts}${expiring}`;
}
function hasWork(work) {
    return work.dueWorkflowCount > 0 || work.pendingDigestCount > 0;
}
/**
 * Whether the run changed anything it was sent to do. New digests or a task
 * coming due mid-run can hide real progress; that reads as no progress, which
 * asks a person to look and loses nothing.
 */
export function madeProgress(before, after) {
    return after.dueWorkflowCount < before.dueWorkflowCount || after.pendingDigestCount < before.pendingDigestCount;
}
async function readDueWork(apiClient, workspaceId) {
    const payload = await apiClient.request(`/api/workspaces/${apiPathSegment(workspaceId)}/orient`, { timeoutMs: DUE_READ_TIMEOUT_MS });
    const { dueWorkflowCount, pendingDigestCount, dueWorkflowsStatus, expiringDigests, omissions } = payload ?? {};
    if (typeof dueWorkflowCount !== 'number' || typeof pendingDigestCount !== 'number') {
        throw new Error('brain answered without the due counts this command needs.');
    }
    const withheld = omissions?.workflows;
    const expiring = expiringDigests;
    const incomplete = typeof withheld === 'string'
        ? `Tasks could not be read: ${withheld}`
        : dueWorkflowsStatus === 'unavailable'
            ? 'Account-level tasks could not be read, so the count may be short.'
            : undefined;
    return {
        dueWorkflowCount,
        pendingDigestCount,
        ...(expiring && typeof expiring.count === 'number' && typeof expiring.soonestExpiresAt === 'string' ? { expiringDigests: expiring } : {}),
        ...(incomplete ? { incomplete } : {}),
    };
}
/** `--workspace`, then the project's `.brainmcp.json`, then this sign-in's default workspace. */
async function resolveRunDueWorkspace(options, apiClient) {
    if (options.workspace)
        return options.workspace;
    const binding = readProjectWorkspaceId(options.cwd);
    if (binding.kind === 'invalid') {
        throw new CliConfigurationError(`${binding.configPath} has no valid workspace binding. Fix it, or pass --workspace <uuid>.`);
    }
    if (binding.kind === 'workspace')
        return binding.workspaceId;
    const creds = await apiClient.getEffectiveCredentials();
    let resolved = resolveOrientWorkspaceId(creds);
    if (!resolved.workspaceId) {
        const listing = await apiClient.request(COMPANION_WORKSPACES_PATH, { timeoutMs: DUE_READ_TIMEOUT_MS });
        resolved = resolveOrientWorkspaceId(creds, listing ?? {});
    }
    if (!resolved.workspaceId) {
        throw new CliConfigurationError('This sign-in reaches several workspaces. Pass --workspace <uuid>, or run `brainmcp bind` in the project.');
    }
    return resolved.workspaceId;
}
/**
 * One agent per workspace on this machine: a run that outlasts the schedule must
 * not start a second agent on the same queue. Kept outside the `locks` directory,
 * whose retention prunes anything older than an hour. Null while a run holds it.
 */
export function acquireRunDueLock(workspaceId, timeoutMs, baseDir) {
    const directory = path.join(resolveStateDir(baseDir), 'run-due');
    ensureDirectory0700(directory);
    const lockPath = path.join(directory, `${workspaceId}.lock`);
    assertNotSymlink(lockPath);
    const isAbandoned = (text, mtimeMs) => {
        try {
            const { pid, expiresAt } = JSON.parse(text);
            return !isProcessAlive(pid) || Date.now() > expiresAt;
        }
        catch {
            // A creator may not have written its metadata yet.
            return Date.now() - mtimeMs > STALE_UNREADABLE_LOCK_MS;
        }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const expiresAt = Date.now() + timeoutMs + 2 * AGENT_STOP_GRACE_MS;
            fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, expiresAt }), { flag: 'wx', mode: 0o600 });
            return () => fs.rmSync(lockPath, { force: true });
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        if (!removeLockIfStill(lockPath, isAbandoned))
            return null;
    }
    return null;
}
/**
 * Runs the agent to its exit. Its stdout goes to stderr under `--json`, so stdout stays one JSON document.
 * Off Windows the agent leads its own process group, so a stop reaches the workers a wrapper starts too,
 * and the run ends, releasing the lock, only once the whole group has gone.
 */
export function runAgent(input) {
    const usesPlaceholder = input.agentCommand.includes(RUN_DUE_PROMPT_PLACEHOLDER);
    const [command, ...args] = input.agentCommand.map((part) => (part === RUN_DUE_PROMPT_PLACEHOLDER ? input.prompt : part));
    const ownGroup = process.platform !== 'win32';
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: input.cwd,
            detached: ownGroup,
            env: { ...process.env, [UNATTENDED_RUN_ENV]: '1' },
            stdio: [usesPlaceholder ? 'ignore' : 'pipe', input.json ? process.stderr : 'inherit', 'inherit'],
        });
        const signalAgent = (signal) => {
            try {
                if (ownGroup && child.pid)
                    process.kill(-child.pid, signal);
                else
                    child.kill(signal);
            }
            catch { /* Already gone. */ }
        };
        const groupAlive = () => {
            if (!ownGroup || !child.pid)
                return false;
            try {
                process.kill(-child.pid, 0);
                return true;
            }
            catch (error) {
                return error.code === 'EPERM';
            }
        };
        let timedOut = false;
        let stoppedAt;
        let killTimer;
        const stop = () => {
            stoppedAt ??= Date.now();
            signalAgent('SIGTERM');
            killTimer ??= setTimeout(() => signalAgent('SIGKILL'), AGENT_STOP_GRACE_MS);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, input.timeoutMs);
        // A cancelled CI job or Ctrl-C ends the agent too, and this process still releases its lock.
        const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        for (const signal of signals)
            process.on(signal, stop);
        const finish = (outcome) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            for (const signal of signals)
                process.off(signal, stop);
            resolve(outcome);
        };
        child.once('error', (error) => finish({ kind: 'not_started', message: error.message }));
        // A wrapper can exit before its workers, whether it finished or was stopped. The run ends when the whole
        // group has: until then the timeout still applies, and a stopped group gets the grace and the kill.
        child.once('close', (code, signal) => {
            const settle = () => {
                const giveUp = stoppedAt !== undefined && Date.now() >= stoppedAt + AGENT_STOP_GRACE_MS + 2_000;
                if (groupAlive() && !giveUp)
                    return void setTimeout(settle, 250);
                finish(timedOut ? { kind: 'timed_out' } : { kind: 'exited', code, signal });
            };
            settle();
        });
        // An agent that never reads stdin must not fail the run with EPIPE.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input.prompt);
    });
}
function report(options, result, exitCode) {
    options.output(options.json ? JSON.stringify(result, null, 2) : result.message);
    return exitCode;
}
export async function runDue(options) {
    const apiClient = options.apiClient ?? new ApiClient({
        store: options.store ?? (await createDefaultCredentialStore({ baseDir: options.baseDir, allowFileCredentials: true, warn: () => undefined })).store,
    });
    const creds = await apiClient.getEffectiveCredentials();
    if (!creds) {
        throw signInRequired('Not signed in. Run `brainmcp login` once on this machine, so this command can check for due work.');
    }
    if (creds.authType === 'service') {
        // A service key reaches only /v1, which has no due-work read.
        throw signInRequired('A service key cannot check for due work. Run `brainmcp login` once on this machine.');
    }
    const workspaceId = await resolveRunDueWorkspace(options, apiClient);
    const before = await readDueWork(apiClient, workspaceId);
    const summary = `Workspace ${workspaceId}: ${describeDueWork(before)}.${before.incomplete ? ` ${before.incomplete}` : ''}`;
    if (!hasWork(before) && before.incomplete) {
        // Zero of a count that could not be read in full is not nothing due: a schedule must see it fail.
        return report(options, { status: 'incomplete', workspaceId, before, message: `${summary} No agent was started; run again later.` }, CLI_EXIT_CODES.GENERAL_ERROR);
    }
    if (!hasWork(before)) {
        return report(options, { status: 'nothing_due', workspaceId, before, message: `${summary} Nothing to run.` }, CLI_EXIT_CODES.SUCCESS);
    }
    const prompt = buildRunDuePrompt(workspaceId);
    if (options.dryRun) {
        return report(options, {
            status: 'dry_run',
            workspaceId,
            before,
            message: `${summary}\nDry run: no agent was started. It would receive this prompt:\n\n${prompt}`,
        }, CLI_EXIT_CODES.SUCCESS);
    }
    const timeoutMs = options.timeoutMinutes * 60_000;
    const releaseLock = acquireRunDueLock(workspaceId, timeoutMs, options.baseDir);
    if (!releaseLock) {
        return report(options, {
            status: 'already_running',
            workspaceId,
            before,
            message: `${summary} An earlier run is still working on this workspace, so no agent was started.`,
        }, CLI_EXIT_CODES.SUCCESS);
    }
    try {
        // Text mode says this first, since the agent's own output comes next and can take a long time.
        if (!options.json)
            options.output(`${summary} Starting ${options.agentCommand[0]}.`);
        const outcome = await runAgent({ agentCommand: options.agentCommand, prompt, cwd: options.cwd, timeoutMs, json: options.json });
        if (outcome.kind === 'not_started') {
            throw new CliConfigurationError(`Could not start the agent command "${options.agentCommand[0]}": ${outcome.message}`);
        }
        if (outcome.kind === 'timed_out') {
            return report(options, {
                status: 'timed_out',
                workspaceId,
                before,
                message: `The agent was stopped after ${options.timeoutMinutes} minutes. Work it finished stays done; the next run continues.`,
            }, CLI_EXIT_CODES.GENERAL_ERROR);
        }
        if (outcome.code !== 0) {
            return report(options, {
                status: 'agent_failed',
                workspaceId,
                before,
                agentExitCode: outcome.code,
                message: `The agent failed (${outcome.code === null ? `signal ${outcome.signal}` : `exit code ${outcome.code}`}).`,
            }, CLI_EXIT_CODES.GENERAL_ERROR);
        }
        let after;
        try {
            after = await readDueWork(apiClient, workspaceId);
        }
        catch (error) {
            return report(options, {
                status: 'unverified',
                workspaceId,
                before,
                agentExitCode: 0,
                message: `The agent finished, but its result could not be checked: ${error instanceof Error ? error.message : String(error)}`,
            }, CLI_EXIT_CODES.SUCCESS);
        }
        if (!madeProgress(before, after)) {
            // A headless agent that cannot reach Brain still exits 0, so this is the signal a schedule gets.
            return report(options, {
                status: 'no_progress',
                workspaceId,
                before,
                after,
                agentExitCode: 0,
                message: `The agent exited successfully but the due work did not go down (${describeDueWork(after)}). The usual cause is an agent that is not signed in to brain on this machine: sign it in once interactively, allow its brain tools, and run this again.`,
            }, CLI_EXIT_CODES.GENERAL_ERROR);
        }
        return report(options, {
            status: 'completed',
            workspaceId,
            before,
            after,
            agentExitCode: 0,
            message: `Done. Now ${describeDueWork(after)}.`,
        }, CLI_EXIT_CODES.SUCCESS);
    }
    finally {
        releaseLock();
    }
}
//# sourceMappingURL=run-due.js.map