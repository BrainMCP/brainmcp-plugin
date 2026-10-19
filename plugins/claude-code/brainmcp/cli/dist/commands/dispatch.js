import { cwd, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { BRAINMCP_CLI_PACKAGE_SPEC, BRAINMCP_GLOBAL_CLIENTS } from '../agent-config.js';
import { CLI_EXIT_CODES, CliConfigurationError } from '../lib/cli-contracts.js';
import { assertClientId, CLIENT_IDS, clientLabel, resolveWorkspace } from '../lib/config.js';
import { OAuthGrantRejectedError } from '../lib/oauth-client.js';
import { CompanionReauthRequiredError } from '../lib/api-client.js';
import { RequestDeadlineError } from '../lib/http.js';
import { SessionLockTimeoutError } from '../runtime/lock.js';
import { cliPackageVersion } from '../runtime/installer.js';
import { doctor, init, initAll, printConfig, remove, } from './index.js';
import { login, logout, whoami } from './auth.js';
import { bindProject } from './bind.js';
import { runHookRuntimeCli } from '../runtime/index.js';
import { captureStatus, captureEnable, captureDisable, captureNow, capturePurgeLocal, capturePurgePreview, } from './capture.js';
export const HELP = `brainmcp — configure BrainMCP for agent projects and authenticate companion CLI

Recommended setup (supported agents, all projects):
  npx --yes ${BRAINMCP_CLI_PACKAGE_SPEC} init --all --scope user

Usage:
  brainmcp init [--client <client>] [--workspace <uuid>] [--scope project|user] [--no-hooks] [--write-back-nudge] [--ignore-plugin] [--yes]
  brainmcp init --all [--workspace <uuid>] [--scope project|user] [--no-hooks] [--write-back-nudge] [--ignore-plugin] [--yes]
  brainmcp doctor [--client <client>] [--workspace <uuid>] [--scope project|user]
  brainmcp print [--client <client>] [--workspace <uuid>] [--scope project|user]
  brainmcp remove [--client <client>] [--scope project|user] [--yes]
  brainmcp login [--capture-digests] [--allow-file-credentials] [--service-token-stdin] [--store-service-token] [--force] [--json]
  brainmcp logout [--json]
  brainmcp whoami [--json]
  brainmcp hook <client> <event>
  brainmcp capture [enable|disable|status|now|purge-local] [--dry-run] [--workspace <uuid>] [--include-prompts] [--yes] [--json]
  brainmcp bind [--workspace <uuid>] [--root <dir>] [--yes] [--json]
  brainmcp unbind [--root <dir>] [--yes] [--json]
  brainmcp --help | -h
  brainmcp --version | -v

Clients: ${CLIENT_IDS.join(', ')}
--all configures ${BRAINMCP_GLOBAL_CLIENTS.map(clientLabel).join(', ')} (generic is client-specific).
Project scope is the default. User scope writes to each host's supported per-user locations.
When the brainmcp plugin is enabled in Claude Code or Codex, init leaves the MCP entry and hooks to the
plugin (removing any it wrote earlier) and writes only guidance; --ignore-plugin keeps the old behavior.
bind writes the project's .brainmcp.json workspace binding (the nearest one inside the Git repository, else one
at the Git root; outside a Git repository or in your home directory only with an explicit --root, which binds
exactly <dir>/.brainmcp.json), so agents there orient to that workspace and capture never lands in another;
bind alone shows the binding.
Every mutation previews a diff and needs confirmation unless a trailing CLI --yes is supplied.
The leading npx --yes above accepts npm's package download; it does not skip the file preview.`;
/** Positional actions; only `capture` takes them. */
const CAPTURE_ACTIONS = new Set(['enable', 'disable', 'status', 'now', 'purge-local']);
export function parseCliArgs(args) {
    const [command, ...rawOptions] = args;
    const result = {
        command,
        yes: false,
        all: false,
        captureDigests: false,
        force: false,
        json: false,
        noHooks: false,
        writeBackNudge: false,
        ignorePlugin: false,
        enable: false,
        disable: false,
        status: false,
        dryRun: false,
        purge: false,
        includePrompts: false,
        now: false,
        allowFileCredentials: false,
        serviceTokenStdin: false,
        storeServiceToken: false,
    };
    for (let index = 0; index < rawOptions.length; index += 1) {
        const option = rawOptions[index];
        if (CAPTURE_ACTIONS.has(option) && command !== 'capture') {
            throw new Error(`Unexpected argument "${option}": positional actions are valid only with \`brainmcp capture\`.`);
        }
        if (option === '--yes' || option === '-y')
            result.yes = true;
        else if (option === '--all')
            result.all = true;
        else if (option === '--capture-digests')
            result.captureDigests = true;
        else if (option === '--force')
            result.force = true;
        else if (option === '--json')
            result.json = true;
        else if (option === '--enable' || option === 'enable')
            result.enable = true;
        else if (option === '--disable' || option === 'disable')
            result.disable = true;
        else if (option === '--status' || option === 'status')
            result.status = true;
        else if (option === '--dry-run')
            result.dryRun = true;
        else if (option === '--purge' || option === 'purge-local')
            result.purge = true;
        else if (option === '--include-prompts')
            result.includePrompts = true;
        else if (option === '--now' || option === 'now')
            result.now = true;
        else if (option === '--allow-file-credentials')
            result.allowFileCredentials = true;
        else if (option === '--service-token-stdin')
            result.serviceTokenStdin = true;
        else if (option === '--store-service-token')
            result.storeServiceToken = true;
        else if (option === '--no-hooks')
            result.noHooks = true;
        else if (option === '--write-back-nudge')
            result.writeBackNudge = true;
        else if (option === '--ignore-plugin')
            result.ignorePlugin = true;
        else if (option === '--client')
            result.client = assertClientId(readValue(rawOptions, ++index, option));
        else if (option === '--workspace')
            result.workspace = resolveWorkspace(readValue(rawOptions, ++index, option));
        else if (option === '--scope') {
            const scope = readValue(rawOptions, ++index, option);
            if (scope !== 'project' && scope !== 'user')
                throw new Error('--scope must be project or user.');
            result.scope = scope;
        }
        else if (option === '--root')
            result.root = readValue(rawOptions, ++index, option);
        else
            throw new Error(`Unknown option: ${option}`);
    }
    if (command === 'capture') {
        const actions = [result.enable, result.disable, result.status, result.now, result.purge].filter(Boolean);
        if (actions.length > 1) {
            throw new Error('Choose exactly one capture action: enable, disable, status, now, or purge-local.');
        }
        const effectiveNow = result.now || (actions.length === 0 && result.dryRun);
        if (result.dryRun && !effectiveNow) {
            throw new Error('--dry-run is valid only with `capture now`.');
        }
        if (result.includePrompts && !result.enable) {
            throw new Error('--include-prompts is valid only with `capture enable`.');
        }
        if (result.workspace && !result.enable && !effectiveNow) {
            throw new Error('--workspace is valid only with `capture enable` or `capture now`.');
        }
    }
    return result;
}
function readValue(args, index, option) {
    const value = args[index];
    if (!value || value.startsWith('-'))
        throw new Error(`${option} requires a value.`);
    return value;
}
export async function defaultConfirm(message) {
    if (!stdin.isTTY || !stdout.isTTY)
        return false;
    const readline = createInterface({ input: stdin, output: stdout });
    try {
        return (await readline.question(`${message} [y/N] `)).trim().toLowerCase() === 'y';
    }
    finally {
        readline.close();
    }
}
/** Socket-level failure codes Node reports on a fetch `cause`. */
const NETWORK_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
]);
function isNetworkFailure(error) {
    if (error instanceof RequestDeadlineError)
        return true;
    if (!error || typeof error !== 'object')
        return false;
    const { name, message, code, cause } = error;
    // Aborted fetches and AbortSignal.timeout() reject with these DOMException names.
    if (name === 'AbortError' || name === 'TimeoutError')
        return true;
    // undici reports transport failures as `TypeError: fetch failed`, with the socket error as `cause`.
    if (error instanceof TypeError && message === 'fetch failed')
        return true;
    const socketCode = typeof code === 'string' ? code : cause?.code;
    return typeof socketCode === 'string' && (NETWORK_ERROR_CODES.has(socketCode) || socketCode.startsWith('UND_ERR_'));
}
/** Map a failed command onto the documented exit codes; anything unclassified is GENERAL_ERROR. */
export function exitCodeForError(error) {
    if (error instanceof CliConfigurationError)
        return CLI_EXIT_CODES.CONFIGURATION_ERROR;
    if (error instanceof CompanionReauthRequiredError || error instanceof OAuthGrantRejectedError) {
        return CLI_EXIT_CODES.AUTH_REQUIRED;
    }
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status : undefined;
    if (status === 401)
        return CLI_EXIT_CODES.AUTH_REQUIRED;
    if (status === 403)
        return CLI_EXIT_CODES.PERMISSION_DENIED;
    if (isNetworkFailure(error))
        return CLI_EXIT_CODES.NETWORK_ERROR;
    // Another BrainMCP process held a local state lock: transient, so the same
    // retryable code as a timed-out request rather than a general failure.
    if (error instanceof SessionLockTimeoutError)
        return CLI_EXIT_CODES.NETWORK_ERROR;
    return CLI_EXIT_CODES.GENERAL_ERROR;
}
export async function dispatch(rawArgs, context = {}) {
    const output = context.output ?? console.log;
    const confirmFn = context.confirm ?? defaultConfirm;
    const currentRoot = context.cwd ?? cwd();
    const [command] = rawArgs;
    if (!command || command === 'help') {
        output(HELP);
        return CLI_EXIT_CODES.SUCCESS;
    }
    // Anywhere on the line, these only print, so `init --help --yes` never runs
    // init. No option takes a value starting with `-`, so neither is ever a value.
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
        output(HELP);
        return CLI_EXIT_CODES.SUCCESS;
    }
    if (command === 'version' || rawArgs.includes('--version') || rawArgs.includes('-v')) {
        output(cliPackageVersion());
        return CLI_EXIT_CODES.SUCCESS;
    }
    if (command === 'hook') {
        // Hooks fail open: a hook must never fail the host agent's lifecycle event.
        await runHookRuntimeCli(rawArgs.slice(1)).catch(() => undefined);
        return CLI_EXIT_CODES.SUCCESS;
    }
    let parsed;
    try {
        parsed = parseCliArgs(rawArgs);
    }
    catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return CLI_EXIT_CODES.USAGE_ERROR;
    }
    if (parsed.all && parsed.client) {
        console.error('Use either --all or --client, not both.');
        return CLI_EXIT_CODES.USAGE_ERROR;
    }
    if (parsed.all && parsed.command !== 'init') {
        console.error('--all is currently supported only by init.');
        return CLI_EXIT_CODES.USAGE_ERROR;
    }
    const legacyOptions = {
        root: parsed.root ?? currentRoot,
        client: parsed.client,
        workspace: parsed.workspace,
        scope: parsed.scope ?? 'project',
        yes: parsed.yes,
        noHooks: parsed.noHooks,
        writeBackNudge: parsed.writeBackNudge,
        ignorePlugin: parsed.ignorePlugin,
        output,
        confirm: confirmFn,
    };
    try {
        switch (parsed.command) {
            case 'init':
                await (parsed.all ? initAll(legacyOptions) : init(legacyOptions));
                return CLI_EXIT_CODES.SUCCESS;
            case 'doctor':
                await doctor(legacyOptions);
                return CLI_EXIT_CODES.SUCCESS;
            case 'print':
                await printConfig(legacyOptions);
                return CLI_EXIT_CODES.SUCCESS;
            case 'remove':
                await remove(legacyOptions);
                return CLI_EXIT_CODES.SUCCESS;
            case 'login':
                if (parsed.serviceTokenStdin && parsed.captureDigests) {
                    // unsafe-logging-allowed: fixed usage text; it names the login mode, never a credential value.
                    console.error('Service credential login cannot be mixed with --capture-digests.');
                    return CLI_EXIT_CODES.USAGE_ERROR;
                }
                if (parsed.storeServiceToken && !parsed.serviceTokenStdin) {
                    // unsafe-logging-allowed: fixed usage text; it names two flags, never a credential value.
                    console.error('--store-service-token is valid only with --service-token-stdin.');
                    return CLI_EXIT_CODES.USAGE_ERROR;
                }
                await login({
                    captureDigests: parsed.captureDigests,
                    force: parsed.force,
                    json: parsed.json,
                    allowFileCredentials: parsed.allowFileCredentials,
                    serviceTokenStdin: parsed.serviceTokenStdin,
                    storeServiceToken: parsed.storeServiceToken,
                    output,
                    openBrowser: context.openBrowser,
                    store: context.store,
                    oauthClient: context.oauthClient,
                });
                return CLI_EXIT_CODES.SUCCESS;
            case 'logout':
                await logout({
                    json: parsed.json,
                    output,
                    store: context.store,
                    oauthClient: context.oauthClient,
                });
                return CLI_EXIT_CODES.SUCCESS;
            case 'whoami': {
                const identity = await whoami({
                    json: parsed.json,
                    output,
                    store: context.store,
                    apiClient: context.apiClient,
                });
                // Only a usable sign-in exits 0, so scripts can gate on `brainmcp whoami`.
                return identity.status === 'authenticated' ? CLI_EXIT_CODES.SUCCESS : CLI_EXIT_CODES.AUTH_REQUIRED;
            }
            case 'capture': {
                let result;
                if (parsed.enable) {
                    result = await captureEnable({
                        baseDir: context.baseDir,
                        includePrompts: parsed.includePrompts,
                        workspace: parsed.workspace,
                        apiClient: context.apiClient,
                        store: context.store,
                    });
                }
                else if (parsed.disable) {
                    result = captureDisable({ baseDir: context.baseDir });
                }
                else if (parsed.purge) {
                    const preview = capturePurgePreview({ baseDir: context.baseDir });
                    const previewText = `${preview.queueItems} queue item(s), ${preview.sessionLedgers} session ledger(s), and ${preview.orientationCacheFiles} orientation cache file(s)`;
                    const confirmed = parsed.yes || await confirmFn(`Delete ${previewText}? Credentials, preferences, and host configuration will be preserved.`);
                    result = confirmed
                        ? capturePurgeLocal({ baseDir: context.baseDir })
                        : {
                            exitCode: CLI_EXIT_CODES.SUCCESS,
                            data: { purged: false, preview, message: 'Local capture purge cancelled; no files were deleted.' },
                        };
                }
                else if (parsed.now || parsed.dryRun) {
                    result = await captureNow({
                        dryRun: parsed.dryRun,
                        baseDir: context.baseDir,
                        cwd: currentRoot,
                        workspace: parsed.workspace,
                        apiClient: context.apiClient,
                        store: context.store,
                    });
                }
                else {
                    result = captureStatus({ baseDir: context.baseDir, json: parsed.json });
                }
                if (parsed.json) {
                    output(JSON.stringify(result.data, null, 2));
                }
                else if (typeof result.data === 'object' && result.data !== null && 'message' in result.data) {
                    output(String(result.data.message));
                    if ('dryRun' in result.data && result.data.dryRun === true && 'payload' in result.data) {
                        output(JSON.stringify(result.data.payload, null, 2));
                    }
                }
                else {
                    output(JSON.stringify(result.data, null, 2));
                }
                return result.exitCode;
            }
            case 'bind':
            case 'unbind':
                if (parsed.command === 'unbind' && parsed.workspace) {
                    console.error('unbind takes no --workspace; it removes the current binding.');
                    return CLI_EXIT_CODES.USAGE_ERROR;
                }
                return await bindProject({
                    startDir: parsed.root ?? currentRoot,
                    explicitRoot: parsed.root !== undefined,
                    workspace: parsed.workspace,
                    unbind: parsed.command === 'unbind',
                    yes: parsed.yes,
                    json: parsed.json,
                    baseDir: context.baseDir,
                    output,
                    confirm: confirmFn,
                });
            default:
                console.error(`Unknown command: ${parsed.command}\n\n${HELP}`);
                return CLI_EXIT_CODES.USAGE_ERROR;
        }
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return exitCodeForError(error);
    }
}
//# sourceMappingURL=dispatch.js.map