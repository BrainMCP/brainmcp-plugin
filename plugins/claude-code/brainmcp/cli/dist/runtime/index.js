import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedStdin, dispatchHookEvent, hookDispatchMaxTimeoutMs, hookDispatchTimeoutMs, pluginSessionStartFailureOutput } from './hook-dispatcher.js';
import { parseHostEvent } from '../hooks/adapters.js';
import { RequestDeadlineError, withRequestDeadline } from '../lib/http.js';
import { isPluginHost } from '../lib/host-plugins.js';
import { logRuntimeEvent } from './diagnostics.js';
import { BACKGROUND_FLUSH_ARG, runBackgroundFlushCli, startBackgroundCaptureFlush } from './background-flush.js';
export * from './storage.js';
export * from './lock.js';
export * from './session.js';
export * from './queue.js';
export * from './retention.js';
export * from './installer.js';
export * from './diagnostics.js';
export * from './hook-dispatcher.js';
export * from './background-flush.js';
/**
 * Time for reading hook input on top of the dispatch budget. The dispatch
 * timer starts only after stdin is read, so the process deadline must exceed
 * the dispatch budget by this much or it cuts dispatch short.
 */
export const HOOK_INPUT_HEADROOM_MS = 500;
/** Marks a hook command a BrainMCP plugin ships (see `HookEvent.fromPlugin`). */
export const FROM_PLUGIN_ARG = '--from-plugin';
/**
 * A plugin vendors the CLI package as `cli/`, and its hooks run
 * `cli/dist/runtime/index.js`, so the CLI entry is `cli/dist/index.js`. Without
 * it (the single-file runtime `init` installs), fall back to `brainmcp login`.
 */
export function pluginLoginCommand(runtimePath) {
    const cliEntry = path.resolve(path.dirname(runtimePath), '..', 'index.js');
    return fs.existsSync(cliEntry) ? `node "${cliEntry}" login` : undefined;
}
/**
 * Whole-process deadline: stdin read plus the longest dispatch budget
 * `dispatchHookEvent` allows for this event (for SessionStart, the cap a token
 * refresh can extend it to). Host hook timeouts written by `init` must exceed
 * it (hooks.test.ts checks every managed config).
 */
export function hookRuntimeDeadlineMs(eventArg, hostArg) {
    return hookDispatchMaxTimeoutMs(eventArg ?? '', hostArg) + HOOK_INPUT_HEADROOM_MS;
}
/**
 * Budgets for one runtime process, from argv alone: the process deadline
 * starts before stdin is read, so the hook input cannot choose it. Every hook
 * `init` writes and every plugin hook passes `<host> <event>`. Without a host
 * argument the budgets assume Claude Code, whose SessionEnd cap is the
 * strictest (700 ms of dispatch against Codex's 2 s); without an event
 * argument, the default event budget applies. Dispatch then runs under these
 * same budgets even when the input names another host or event, so its own
 * timer never outlasts the process deadline.
 */
export function hookRuntimeBudget(args) {
    const event = args[1] ?? '';
    const host = args[0] || 'claude-code';
    return {
        deadlineMs: hookRuntimeDeadlineMs(event, host),
        timeoutMs: hookDispatchTimeoutMs(event, host),
        maxTimeoutMs: hookDispatchMaxTimeoutMs(event, host),
    };
}
/**
 * Main execution function when runtime script is called directly by agent host hooks.
 */
export async function runHookRuntimeCli(args = process.argv.slice(2)) {
    // A detached delivery process a hook started: no hook input, its own deadline.
    if (args[0] === BACKGROUND_FLUSH_ARG) {
        await runBackgroundFlushCli(args);
        return;
    }
    // The detached process runs this same bundle.
    const runtimePath = fileURLToPath(import.meta.url);
    const budget = hookRuntimeBudget(args);
    const fromPlugin = args.includes(FROM_PLUGIN_ARG);
    let normalizedEvent;
    let output = {};
    try {
        output = await withRequestDeadline(budget.deadlineMs, undefined, async (signal) => {
            const rawInput = await readBoundedStdin(process.stdin, undefined, signal);
            if (!rawInput.trim())
                return {};
            let parsed;
            try {
                parsed = JSON.parse(rawInput);
            }
            catch {
                return {};
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('Invalid hook input');
            const host = String(args[0] || parsed.client || 'claude-code');
            const eventName = String(args[1] || parsed.event || parsed.hook_event_name || 'GenericEvent');
            normalizedEvent = parseHostEvent(host, parsed, eventName);
            normalizedEvent.nudgeLedger = args.includes('--nudge-ledger');
            normalizedEvent.fromPlugin = fromPlugin;
            const res = await dispatchHookEvent(normalizedEvent, {
                signal,
                timeoutMs: budget.timeoutMs,
                maxTimeoutMs: budget.maxTimeoutMs,
                loginCommand: fromPlugin ? pluginLoginCommand(runtimePath) : undefined,
                startBackgroundFlush: ({ baseDir }) => startBackgroundCaptureFlush({ runtimePath, baseDir }),
            });
            if (res.outputPayload && Object.keys(res.outputPayload).length > 0) {
                return res.outputPayload;
            }
            signal.throwIfAborted();
            return res.outputPayload ?? {};
        });
    }
    catch (error) {
        logRuntimeEvent('warn', 'hook_input_or_deadline_failed');
        const host = normalizedEvent?.client ?? args[0];
        const eventName = normalizedEvent?.event ?? args[1];
        if (error instanceof RequestDeadlineError && fromPlugin && host && isPluginHost(host) && eventName === 'SessionStart') {
            // The plugin's argv identifies SessionStart even if stdin never finished.
            let cwd;
            try {
                cwd = process.cwd();
            }
            catch {
                cwd = undefined;
            }
            const event = normalizedEvent ?? parseHostEvent(host, cwd ? { cwd } : {}, eventName);
            event.fromPlugin = true;
            output = pluginSessionStartFailureOutput(event, 'timeout');
        }
    }
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exitCode = 0;
}
function isMainModule() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(entry));
    }
    catch {
        return false;
    }
}
if (isMainModule()) {
    void runHookRuntimeCli();
}
//# sourceMappingURL=index.js.map