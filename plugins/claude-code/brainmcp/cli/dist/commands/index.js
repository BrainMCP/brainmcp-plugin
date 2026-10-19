import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BRAIN_BOOTSTRAP_PROMPT, BRAIN_DOCS_URL, BRAIN_MCP_ENDPOINT, BRAIN_MCP_INITIAL_SCOPES, BRAIN_OAUTH_AUTH_METADATA_CANONICAL_URL, BRAIN_OAUTH_AUTH_METADATA_URL, BRAIN_OAUTH_ISSUER, BRAIN_OAUTH_RESOURCE_METADATA_COMPAT_URL, BRAIN_OAUTH_RESOURCE_METADATA_URL, BRAINMCP_CLI_CLIENTS, BRAINMCP_CLI_PACKAGE_SPEC, BRAINMCP_GLOBAL_CLIENTS, MCP_OAUTH_CLIENT_IDS, buildBrainmcpDoctorCommand, buildBrainmcpInitCommand, buildBrainVerificationPrompt, GUIDANCE_VERSION, } from '../agent-config.js';
import { clientLabel, guidancePreamble, renderGuidance, resolveWorkspace, targetFor, describeAntigravityServerConfig, } from '../lib/config.js';
import { applyChanges, exists, readText, renderDiff, toAbsolute } from '../lib/files.js';
import { BACKUP_MAX_AGE_MS, BACKUP_MAX_PER_FILE, findLegacyBackups, getBackupsDir } from '../lib/backups.js';
import { splitTomlSections, parseJsonc, removeJsoncPath, removeJsonServer, removeMarkdownBlock, removeTomlBlock, upsertJsoncPath, upsertJsonServer, upsertMarkdownBlock, upsertTomlBlock } from '../lib/managed.js';
import { checkCredentialHealth, checkRuntimeDrift, checkConsentPreferences, checkQueueStatus, checkCompanionApiTarget } from '../runtime/doctor-checks.js';
import { checkProjectBinding } from './bind.js';
import { companionWorkspacesUrl } from '../lib/endpoints.js';
import { getBrainHome } from '../runtime/storage.js';
import { CliConfigurationError, isWorkspaceUuid } from '../lib/cli-contracts.js';
import { RequestDeadlineError, withRequestDeadline } from '../lib/http.js';
import { cliPackageVersion, getRuntimeShimPath, getVersionedRuntimePath, loadPackagedRuntimeBundle, renderRuntimeShim, } from '../runtime/installer.js';
import { managedHookEvents, managedHookPositions, managedNonNudgeHookEvents, removeClaudeManagedHooks, removeCodexManagedHooks, removeCursorManagedHooks, removeVsCodeManagedHooks, upsertClaudeManagedHooks, upsertClaudeNudgeHooks, upsertCodexManagedHooks, upsertCursorManagedHooks, upsertVsCodeManagedHooks, } from '../hooks/managed-hooks.js';
import { claudeConfigDir, codexManagedHookTrust, describePluginInstall, detectHostPlugin, isPluginHost, PLUGIN_HOOK_EVENTS, pluginReplacingInit, pluginRunsAllHooks, pluginRunsHook, } from '../lib/host-plugins.js';
/**
 * Deadline for each public discovery probe in `doctor`, body read included. A
 * silent or trickling endpoint fails its check instead of stalling the command.
 */
const DOCTOR_PROBE_TIMEOUT_MS = 8_000;
export async function detectClients(root) {
    const candidates = [
        ['cursor', ['.cursor', '.cursor/mcp.json']],
        ['claude-code', ['CLAUDE.md', '.mcp.json']],
        ['codex', ['.codex', '.codex/config.toml']],
        ['vscode', ['.vscode', '.vscode/mcp.json']],
        ['copilot', ['.github/copilot-instructions.md', '.copilot/mcp-config.json']],
        ['antigravity', ['.agents/mcp_config.json', '.agents/rules', '.agent/rules']],
    ];
    const detected = [];
    for (const [client, paths] of candidates) {
        if (await Promise.all(paths.map((path) => exists(resolve(root, path)))).then((values) => values.some(Boolean)))
            detected.push(client);
    }
    return detected;
}
export async function chooseClient(options) {
    if (options.client)
        return options.client;
    const clients = await detectClients(options.root);
    if (clients.length === 1)
        return clients[0];
    if (clients.length === 0)
        return 'generic';
    throw new Error(`Detected multiple clients (${clients.join(', ')}). Choose one with --client.`);
}
export async function init(options) {
    const client = await chooseClient(options);
    await assertSingleMcpConfigScope(options, [client]);
    const workspace = resolveWorkspace(options.workspace);
    const plugin = replacingPlugin(options, client);
    const changes = await plannedChanges(options, client, workspace, 'init', plugin);
    await previewAndApply(changes, options);
    options.output(`BrainMCP configured for ${clientLabel(client)}.`);
    if (plugin)
        options.output(pluginInitNote(client, plugin, keepsNudgeBesidePlugin(options, client, plugin)));
    options.output(renderSetupNextSteps([client], options.scope, workspace));
}
export async function initAll(options) {
    const workspace = resolveWorkspace(options.workspace);
    await assertSingleMcpConfigScope(options, BRAINMCP_GLOBAL_CLIENTS);
    const plugins = BRAINMCP_GLOBAL_CLIENTS.map((client) => replacingPlugin(options, client));
    const groups = await Promise.all(BRAINMCP_GLOBAL_CLIENTS.map((client, index) => plannedChanges(options, client, workspace, 'init', plugins[index])));
    await previewAndApply(mergeFileChanges(groups.flat()), options);
    options.output(`BrainMCP configured for ${BRAINMCP_GLOBAL_CLIENTS.map(clientLabel).join(', ')}.`);
    BRAINMCP_GLOBAL_CLIENTS.forEach((client, index) => {
        const plugin = plugins[index];
        if (plugin)
            options.output(pluginInitNote(client, plugin, keepsNudgeBesidePlugin(options, client, plugin)));
    });
    options.output(renderSetupNextSteps(BRAINMCP_GLOBAL_CLIENTS, options.scope, workspace));
}
/**
 * The enabled host plugin that already provides this client's MCP entry and
 * lifecycle hooks at the selected scope, unless `--ignore-plugin` was given.
 */
function replacingPlugin(options, client) {
    if (options.ignorePlugin || !isPluginHost(client))
        return undefined;
    return pluginReplacingInit(client, options.scope, {
        home: options.home ?? homedir(),
        env: options.env ?? process.env,
        root: options.root,
    });
}
/**
 * Whether init keeps the requested write-back nudge although the host's plugin
 * runs every lifecycle hook: no plugin ships the nudge (only Claude Code has one).
 */
function keepsNudgeBesidePlugin(options, client, plugin) {
    return Boolean(options.writeBackNudge && !options.noHooks && client === 'claude-code' && plugin &&
        isPluginHost(client) && pluginRunsAllHooks(client, plugin));
}
function pluginInitNote(client, plugin, keptNudge = false) {
    if (!isPluginHost(client))
        return '';
    const authenticate = client === 'claude-code'
        ? 'In Claude Code, run /mcp, select plugin:brainmcp:brain, and choose Authenticate.'
        : 'In Codex, run `codex mcp login brain` if it is not signed in yet.';
    if (!pluginRunsAllHooks(client, plugin)) {
        return `${describePluginInstall(client, plugin)} provides the brain MCP server, so init removed any MCP entry it had written before. Codex skips the plugin's hooks until you trust them, so init kept its own hooks (Codex asks you to trust those too); each one stands aside once you trust the plugin's matching hook (run /hooks in Codex). Rerun init after trusting them to remove init's hooks. ${authenticate} Rerun with --ignore-plugin to keep init's own entry as well.`;
    }
    if (keptNudge) {
        return `${describePluginInstall(client, plugin)} provides the brain MCP server and lifecycle hooks, so init removed any MCP entry or hooks it had written before. It wrote the managed guidance and the write-back nudge you asked for, which the plugin does not ship: a Stop hook, plus UserPromptSubmit and PostToolUse hooks that count activity for it. Those two store no content and stand aside while capture is on, when the plugin's hooks record the session. ${authenticate} Rerun with --ignore-plugin to keep init's own entry and hooks instead; they stand aside while the plugin's hooks run.`;
    }
    return `${describePluginInstall(client, plugin)} provides the brain MCP server and lifecycle hooks, so init wrote only the managed guidance and removed any MCP entry or hooks it had written before. ${authenticate} Rerun with --ignore-plugin to keep init's own entry and hooks instead; they stand aside while the plugin's hooks run.`;
}
function renderSetupNextSteps(clients, scope, workspace) {
    const clientList = clients.map(clientLabel).join(', ');
    const doctorCommands = clients.map((client) => `   ${buildBrainmcpDoctorCommand({ client, scope, workspaceId: workspace })}`);
    const authorizationSteps = clients.map((client) => {
        switch (client) {
            case 'claude-code':
                return '   - Claude Code: start a session, run /mcp, select brain, then choose Authenticate.';
            case 'cursor':
                return '   - Cursor: open Settings > Tools & MCP, select brain, then connect or authorize it.';
            case 'codex':
                return '   - Codex: run `codex mcp login brain` and finish the browser flow. When Codex asks you to review hooks, trust the BrainMCP hooks (or later in /hooks); Codex does not run untrusted hooks.';
            case 'vscode':
                return '   - VS Code (Copilot Chat): start brain from MCP: List Servers or the mcp.json CodeLens, then choose Auth and complete browser sign-in.';
            case 'copilot':
                return '   - GitHub Copilot CLI: run `copilot`, open `/mcp`, select brain, and authenticate; if its status is `needs-auth`, run `/mcp auth brain`.';
            case 'antigravity':
                return '   - Antigravity: in the IDE open Settings → Customizations and Authenticate brain (or … → MCP Servers to confirm it is listed); in agy run /mcp, select brain, and finish OAuth. Paste an authorization code back into settings if prompted.';
            default:
                return `   - ${clientLabel(client)}: start the brain HTTP MCP connection and complete its browser OAuth flow.`;
        }
    });
    return [
        '',
        'Next steps:',
        '1. Sign in at https://dash.brainmcp.ai and create one workspace for this project if you do not already have one (or ask a connected agent to create it). Bind each repository to its workspace with `brainmcp bind --workspace <uuid>`.',
        `2. Keep the reserved brain server in exactly one MCP config scope per client (project or user), then restart or reopen ${clientList}.`,
        '3. Log in to brain from every client you plan to use:',
        ...authorizationSteps,
        '4. In browser consent, review the scopes, select the workspace(s) this client may reach, and choose its default workspace.',
        `5. Verify with a read-only agent prompt (guidance ${GUIDANCE_VERSION}):`,
        `   ${buildBrainVerificationPrompt({ workspaceId: workspace })}`,
        '   Confirm the dashboard Connect view shows Agent seen after a successful authenticated tool call.',
        '6. If the workspace is empty, copy and paste this bootstrap command into the connected agent:',
        ...BRAIN_BOOTSTRAP_PROMPT.split('\n').map((line) => `   ${line}`),
        '7. Follow the proposal status the agent reports. If it awaits Review, approve, edit, or reject it in the dashboard. The workspace is not populated until the proposal is applied.',
        '8. Keep the installed guidance enabled so agents orient before non-trivial work and propose only new durable project knowledge afterward.',
        '9. Check local configuration and public service discovery if needed:',
        ...doctorCommands,
        `Guide: ${BRAIN_DOCS_URL}/quickstart`,
        '',
        'Safe to rerun: init restores the selected release defaults for the reserved brain server entry and BrainMCP-managed instructions. It preserves unrelated servers and text outside shared managed blocks, and backs up changed existing files, except ones clean in Git (into ~/.brainmcp/backups, or $BRAINMCP_HOME/backups).',
        'No API keys or OAuth secrets were written to configuration files.',
    ].join('\n');
}
export async function remove(options) {
    const client = await chooseClient(options);
    const changes = await plannedChanges(options, client, undefined, 'remove');
    if (changes.every((change) => change.before === change.after)) {
        options.output('No BrainMCP-managed configuration found.');
        return;
    }
    await previewAndApply(changes, options);
    options.output(`Removed BrainMCP-managed ${clientLabel(client)} configuration.`);
}
export async function printConfig(options) {
    const client = await chooseClient(options);
    const workspace = resolveWorkspace(options.workspace);
    const target = resolveTarget(options, targetFor(client, options.scope));
    options.output(`# ${clientLabel(client)} (${options.scope} scope)\n\nMCP configuration: ${target.configPath}\n\n${target.format === 'toml' ? upsertTomlBlock(undefined, client) : upsertJsonServer(undefined, client, target.rootKey, options.scope)}\nGuidance: ${target.guidancePath}\n\n${upsertGuidance(undefined, client, options.scope, workspace)}`);
}
export async function doctor(options) {
    const requestedWorkspace = resolveWorkspace(options.workspace);
    const client = await chooseClient(options);
    const target = resolveTarget(options, targetFor(client, options.scope));
    const checks = [];
    const config = await readText(target.configPath);
    const guidance = await readText(target.guidancePath);
    const home = options.home ?? homedir();
    const hookFile = target.hookPath
        ? resolveHookFilePath(target.hookPath, { scope: options.scope, home, root: options.root })
        : undefined;
    const hookText = hookFile ? await readText(hookFile) : undefined;
    let hookJson;
    try {
        hookJson = hookText?.trim() ? parseJsonc(hookText) : undefined;
    }
    catch {
        hookJson = undefined;
    }
    const managedEvents = managedHookEvents(hookJson);
    let hasBrainEntry;
    try {
        hasBrainEntry = config !== undefined && hasBrainServerConfig(config, target);
    }
    catch {
        // Unparseable: it may hold an entry; the syntax check below reports it.
        hasBrainEntry = true;
    }
    const hasManagedGuidance = guidance !== undefined && /brainmcp:managed:(?:start|end)/.test(guidance);
    // An enabled plugin supplies the MCP entry and hooks itself; init's own copy
    // would load Brain twice. Doctor yields to the same plugin init does, so a
    // user-scope plugin never asks to strip a project's committed setup.
    const pluginLookup = { home, env: options.env ?? process.env, root: options.root };
    const replacingInit = isPluginHost(client) ? pluginReplacingInit(client, options.scope, pluginLookup) : undefined;
    const activePlugin = isPluginHost(client) && !replacingInit ? detectHostPlugin(client, pluginLookup).active : undefined;
    // A user-scope plugin serves every project, so a project init never touched is
    // a plugin-only setup, not a broken one; only a partial project setup fails.
    const pluginOnlyProject = options.scope === 'project' && activePlugin?.scope === 'user' &&
        !hasBrainEntry && managedEvents.length === 0 && !hasManagedGuidance;
    const plugin = replacingInit ?? (pluginOnlyProject ? activePlugin : undefined);
    const otherPlugin = plugin ? undefined : activePlugin;
    const pluginOwnsConfig = plugin !== undefined && !hasBrainEntry;
    // The plugin's using-brainmcp skill stands in for guidance init never wrote.
    const pluginCoversGuidance = plugin !== undefined && !hasManagedGuidance;
    // Codex runs a hook from hooks.json only after the user trusts it, init's own
    // included; file presence alone does not mean a hook runs.
    const codexTrust = client === 'codex' && hookFile && managedEvents.length > 0
        ? codexManagedHookTrust(hookFile, managedHookPositions(hookJson), { home, env: options.env ?? process.env })
        : undefined;
    const trustDetail = (trust) => [
        trust.untrusted.length ? `${trust.untrusted.join(', ')} untrusted` : '',
        trust.disabled.length ? `${trust.disabled.join(', ')} disabled` : '',
    ].filter(Boolean).join('; ');
    if (plugin && isPluginHost(client)) {
        const repairCommand = buildBrainmcpInitCommand({ client, scope: options.scope });
        checks.push(['host plugin', true, `${describePluginInstall(client, plugin)} provides the brain MCP server and hooks${pluginOnlyProject ? ' (plugin-only; project scope not configured)' : ''}`]);
        checks.push([
            'single brain MCP source',
            pluginOwnsConfig,
            pluginOwnsConfig
                ? 'only the plugin configures brain'
                : `${target.configPath} also configures brain; preview ${repairCommand}, which removes init's entry and hooks while the plugin is enabled`,
        ]);
        // Codex skips plugin hooks the user has not trusted; init's hooks are then
        // the fallback for those events, not a duplicate.
        const skippedEvents = PLUGIN_HOOK_EVENTS.filter((event) => !pluginRunsHook(client, plugin, event));
        if (skippedEvents.length === 0) {
            // The write-back nudge is no duplicate: no plugin ships one.
            const duplicates = managedNonNudgeHookEvents(hookJson);
            const nudgeEvents = managedEvents.filter((event) => !duplicates.includes(event));
            checks.push([
                'single hook source',
                duplicates.length === 0,
                duplicates.length > 0
                    ? `${hookFile} still has init's ${duplicates.join(', ')} hooks (they stand aside while the plugin's hooks run); preview ${repairCommand} to remove them`
                    : nudgeEvents.length > 0
                        ? `only the plugin installs BrainMCP lifecycle hooks; init's write-back nudge (${nudgeEvents.join(', ')}) runs beside them`
                        : 'only the plugin installs BrainMCP hooks',
            ]);
        }
        else {
            // An init hook covers a skipped event only if Codex runs it, which takes trust too.
            const runningManaged = codexTrust?.trusted ?? managedEvents;
            const uncovered = skippedEvents.filter((event) => !runningManaged.includes(event));
            const missing = uncovered.filter((event) => !managedEvents.includes(event));
            const notRunning = uncovered.filter((event) => managedEvents.includes(event));
            checks.push([
                'plugin hooks trusted',
                uncovered.length === 0,
                uncovered.length === 0
                    ? `Codex skips the plugin's untrusted ${skippedEvents.join(', ')} hooks, so init's hooks in ${hookFile} run instead; trust the plugin's hooks with /hooks in Codex, then preview ${repairCommand} to remove init's`
                    : [
                        `Codex skips the plugin's untrusted ${uncovered.join(', ')} hooks`,
                        missing.length ? ` and no init hook covers ${missing.join(', ')}` : '',
                        notRunning.length ? `${missing.length ? ', and' : ' and'} init's own ${notRunning.join(', ')} hooks in ${hookFile} are not trusted either (${codexTrust ? trustDetail(codexTrust) : 'untrusted'})` : '',
                        ', so orientation and capture do not run there; trust them with /hooks in Codex (or restart Codex and choose Trust all and continue)',
                        missing.length ? `, or preview ${repairCommand}, which keeps init's hooks until you do` : '',
                    ].join(''),
            ]);
        }
    }
    else {
        if (otherPlugin && isPluginHost(client)) {
            // An untouched project passes as plugin-only above; a project setup missing its entry or guidance is partial.
            const partial = options.scope === 'project' && otherPlugin.scope === 'user' && (!hasBrainEntry || !hasManagedGuidance);
            checks.push(['host plugin', true, [
                    `${describePluginInstall(client, otherPlugin)} also loads brain; init does not yield to it at ${options.scope} scope, so doctor checks the ${options.scope}-scope setup init writes`,
                    managedEvents.length > 0 ? " (init's hooks stand aside while the plugin's run)" : '',
                    partial ? `; this project has only part of it: preview ${buildBrainmcpInitCommand({ client, scope: options.scope })} to complete it, or ${brainmcpRemoveCommand(client, options.scope)} to rely on the plugin alone` : '',
                ].join('')]);
        }
        checks.push(['configuration placement', config !== undefined, config ? target.configPath : `missing ${target.configPath}`]);
        if (codexTrust) {
            const blocked = trustDetail(codexTrust);
            checks.push([
                'Codex hook trust',
                blocked === '',
                blocked === ''
                    ? `Codex has a trust record for each of init's hooks in ${hookFile} (it still skips one /hooks shows as Modified)`
                    : `Codex does not run init's hooks in ${hookFile} until you trust them: ${blocked}; trust them with /hooks in Codex (or restart Codex and choose Trust all and continue)`,
            ]);
        }
    }
    checks.push(['guidance placement', guidance !== undefined || plugin !== undefined, pluginCoversGuidance
            ? `no managed guidance at ${target.guidancePath}; the plugin's using-brainmcp skill covers it`
            : guidance ? target.guidancePath : `missing ${target.guidancePath}`]);
    if (config !== undefined && !pluginOwnsConfig) {
        try {
            if (target.format === 'jsonc') {
                const json = parseJsonc(config);
                const server = json[target.rootKey]?.brain;
                const result = describeMcpServerConfig(client, options.scope, server);
                checks.push(['configuration syntax and endpoint', result.ok, result.detail]);
            }
            else {
                // The same splitter as init/remove, so a following `[[array]]` table
                // ends the section and its keys never count for Brain's tables.
                const sections = splitTomlSections(config);
                const servers = sections.filter((section) => section.name === 'mcp_servers.brain');
                const oauth = sections.filter((section) => section.name === 'mcp_servers.brain.oauth');
                const valueIs = (body, key, expected) => {
                    const assignments = body.split(/\r?\n/).filter((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
                    // Matching quotes only: `"…'` is not a TOML string.
                    return assignments.length === 1 && new RegExp(`^\\s*${key}\\s*=\\s*(["'])${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*(?:#.*)?$`).test(assignments[0]);
                };
                const hasStableCodexOAuth = servers.length === 1 && oauth.length === 1 &&
                    !servers[0].isArray && !oauth[0].isArray &&
                    valueIs(servers[0].body, 'url', BRAIN_MCP_ENDPOINT) &&
                    valueIs(servers[0].body, 'oauth_resource', BRAIN_MCP_ENDPOINT) &&
                    valueIs(oauth[0].body, 'client_id', MCP_OAUTH_CLIENT_IDS.codex);
                checks.push([
                    'configuration syntax and endpoint',
                    hasStableCodexOAuth,
                    hasStableCodexOAuth ? 'brain TOML block with stable Codex OAuth client' : 'missing canonical Codex OAuth client/resource',
                ]);
            }
        }
        catch (error) {
            checks.push(['configuration syntax and endpoint', false, error instanceof Error ? error.message : String(error)]);
        }
    }
    if (guidance !== undefined && !pluginCoversGuidance) {
        const occurrences = (guidance.match(/brainmcp:managed:start/g) ?? []).length;
        const normalizedGuidance = guidance.replace(/\r\n/g, '\n');
        const ends = (guidance.match(/brainmcp:managed:end/g) ?? []).length;
        const blocks = normalizedGuidance.match(/<!-- brainmcp:managed:start[^\n]*-->[\s\S]*?<!-- brainmcp:managed:end -->/g) ?? [];
        const validMarkers = occurrences === 1 && ends === 1 && blocks.length === 1;
        checks.push(['managed guidance markers', validMarkers, validMarkers ? 'one complete managed block' : `${occurrences} starts, ${ends} ends, ${blocks.length} complete blocks`]);
        const installedWorkspace = blocks[0]?.match(/^Workspace id: (.+)$/m)?.[1]?.trim();
        // Installs from before --workspace required a UUID may bind a slug, which
        // MCP tools reject. Never suggest repeating it: init now refuses a slug.
        const slugBinding = !requestedWorkspace && installedWorkspace !== undefined && !isWorkspaceUuid(installedWorkspace);
        const expectedWorkspace = requestedWorkspace ?? installedWorkspace;
        const expectedGuidance = renderGuidance(client, expectedWorkspace).trim();
        const currentGuidance = validMarkers && blocks[0] === expectedGuidance;
        const repairCommand = slugBinding
            ? `${buildBrainmcpInitCommand({ client, scope: options.scope })} --workspace <workspace-uuid>`
            : buildBrainmcpInitCommand({ client, scope: options.scope, workspaceId: expectedWorkspace });
        checks.push([
            'managed guidance content', currentGuidance,
            currentGuidance ? `matches bundled guidance ${GUIDANCE_VERSION}` : `outdated or modified; preview repair with ${repairCommand}`,
        ]);
        checks.push(slugBinding
            ? ['workspace binding', false, `bound to a workspace slug or name, not its UUID, so agents cannot use it; rerun ${repairCommand} with the workspace UUID (\`brainmcp whoami\` lists authorized workspace UUIDs after \`brainmcp login\`, as does brain_workspaces_list in a connected agent)`]
            : ['workspace binding', !requestedWorkspace || guidance.includes(`Workspace id: ${requestedWorkspace}`), requestedWorkspace ? 'requested workspace binding' : 'no workspace requested']);
        if ((client === 'vscode' || client === 'copilot') && options.scope === 'user') {
            checks.push([
                'user instruction frontmatter',
                guidance.startsWith('---\n') &&
                    /^applyTo:\s*["']\*\*["']$/m.test(guidance) &&
                    guidance.includes('\n---\n'),
                'always-on VS Code user instruction',
            ]);
        }
        if (client === 'antigravity' && options.scope === 'project') {
            checks.push([
                'workspace rule frontmatter',
                guidance.startsWith('---\n') &&
                    /^trigger:\s*always_on$/m.test(guidance) &&
                    guidance.includes('\n---\n'),
                'always-on Antigravity workspace rule',
            ]);
        }
    }
    if (requiresSingleMcpConfigScope(client)) {
        const otherScope = oppositeScope(options.scope);
        const duplicate = await inspectOtherMcpConfigScope(options, client);
        checks.push([
            'single MCP configuration scope',
            duplicate.status === 'absent',
            duplicate.status === 'present'
                ? `brain is also configured at ${duplicate.path}; keep it in only one scope`
                : duplicate.status === 'invalid'
                    ? `cannot inspect ${duplicate.path}: ${duplicate.error}`
                    : `no ${otherScope}-scope brain entry`,
        ]);
    }
    const fetchImpl = options.fetch ?? fetch;
    const probeTimeoutMs = options.probeTimeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS;
    // Probes run in parallel. Each one, body read included, has its own deadline
    // and refuses redirects (as the OAuth client does), so a silent, trickling, or
    // redirected endpoint fails its own check instead of stalling doctor.
    const probe = async (name, check) => {
        try {
            const result = await withRequestDeadline(probeTimeoutMs, undefined, (signal) => check((url, init) => fetchImpl(url, { ...init, redirect: 'error', signal })));
            return [name, result.ok, result.detail];
        }
        catch (error) {
            return [name, false, probeFailureDetail(error, probeTimeoutMs)];
        }
    };
    const apiOriginCheck = checkCompanionApiTarget();
    const networkChecks = [
        ...[
            ['OAuth issuer discovery', BRAIN_OAUTH_AUTH_METADATA_CANONICAL_URL],
            ['OAuth issuer compatibility alias', BRAIN_OAUTH_AUTH_METADATA_URL],
        ].map(([name, url]) => probe(name, async (request) => {
            const discovery = await request(url, { headers: { accept: 'application/json' } });
            return discovery.ok
                ? validateOAuthAuthorizationMetadata(await discovery.json())
                : { ok: false, detail: `HTTP ${discovery.status}` };
        })),
        ...[
            ['OAuth resource discovery', BRAIN_OAUTH_RESOURCE_METADATA_URL],
            ['OAuth resource compatibility alias', BRAIN_OAUTH_RESOURCE_METADATA_COMPAT_URL],
        ].map(([name, url]) => probe(name, async (request) => {
            const discovery = await request(url, { headers: { accept: 'application/json' } });
            return discovery.ok
                ? validateOAuthProtectedResourceMetadata(await discovery.json())
                : { ok: false, detail: `HTTP ${discovery.status}` };
        })),
        probe('endpoint challenge', async (request) => {
            const challenge = await request(BRAIN_MCP_ENDPOINT, {
                body: JSON.stringify({
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'initialize',
                    params: {
                        capabilities: {},
                        clientInfo: { name: 'brainmcp-doctor', version: '1.0.0' },
                        protocolVersion: '2025-11-25',
                    },
                }),
                headers: {
                    accept: 'application/json, text/event-stream',
                    'content-type': 'application/json',
                },
                method: 'POST',
            });
            const wwwAuthenticate = challenge.headers.get('www-authenticate') ?? '';
            const valid = challenge.status === 401 &&
                /^Bearer\b/i.test(wwwAuthenticate) &&
                wwwAuthenticate.includes(`resource_metadata="${BRAIN_OAUTH_RESOURCE_METADATA_URL}"`) &&
                wwwAuthenticate.includes(`scope="${BRAIN_MCP_INITIAL_SCOPES.join(' ')}"`);
            return {
                ok: valid,
                detail: valid ? `HTTP 401 → ${BRAIN_OAUTH_RESOURCE_METADATA_URL}` : `HTTP ${challenge.status}; incomplete Bearer challenge`,
            };
        }),
        // Local, but listed here to keep the established check order.
        Promise.resolve([apiOriginCheck.name, apiOriginCheck.passed, apiOriginCheck.detail]),
        probe('companion workspaces endpoint', async (request) => {
            const workspacesUrl = companionWorkspacesUrl();
            const workspaces = await request(workspacesUrl, { headers: { accept: 'application/json' } });
            const valid = workspaces.status === 401 || workspaces.status === 403;
            return {
                ok: valid,
                detail: valid
                    ? `HTTP ${workspaces.status} at ${workspacesUrl}`
                    : `HTTP ${workspaces.status} at ${workspacesUrl}; companion REST belongs on the API origin, not MCP`,
            };
        }),
    ];
    checks.push(...await Promise.all(networkChecks));
    const brainHome = brainHomeFor(options);
    const credCheck = await checkCredentialHealth(brainHome, { probeVault: !options.home });
    checks.push([credCheck.name, credCheck.passed, credCheck.detail]);
    if (plugin) {
        checks.push(['hook runtime', true, `the plugin's hooks run its own vendored CLI${plugin.version ? ` ${plugin.version}` : ''}`]);
    }
    // Hooks init wrote beside a plugin (Codex fallbacks, the write-back nudge) run init's runtime.
    if (!plugin || managedEvents.length > 0) {
        const driftCheck = checkRuntimeDrift(cliPackageVersion(), brainHome);
        checks.push([driftCheck.name, driftCheck.passed, driftCheck.detail]);
    }
    const consentCheck = checkConsentPreferences(brainHome);
    checks.push([consentCheck.name, consentCheck.passed, consentCheck.detail]);
    const queueCheck = checkQueueStatus(brainHome);
    checks.push([queueCheck.name, queueCheck.passed, queueCheck.detail]);
    if (options.scope === 'project')
        checks.push(checkProjectBinding(options.root, brainHome));
    // Informational: releases through 0.1.38 left `<file>.brainmcp.bak-*` copies
    // beside each changed file. They are the user's files, so nothing deletes them.
    const legacyBackups = await findLegacyBackups([target.configPath, target.guidancePath, hookFile]);
    if (legacyBackups.length > 0) {
        const shown = legacyBackups.slice(0, 5);
        checks.push([
            'legacy backups',
            true,
            `${legacyBackups.length} .brainmcp.bak-* ${legacyBackups.length === 1 ? 'copy' : 'copies'} from an earlier release beside the configuration: ${shown.join(', ')}${legacyBackups.length > shown.length ? `, and ${legacyBackups.length - shown.length} more` : ''}. BrainMCP no longer writes or deletes these; new backups go to ${getBackupsDir(brainHome)} (pruned after ${BACKUP_MAX_AGE_MS / 86_400_000} days, at most ${BACKUP_MAX_PER_FILE} per file). Delete them once you no longer need them`,
        ]);
    }
    for (const [name, passed, detail] of checks)
        options.output(`${passed ? '✓' : '✗'} ${name}: ${detail}`);
    if (checks.some(([, passed]) => !passed))
        throw new CliConfigurationError('BrainMCP doctor found configuration issues.');
}
const SINGLE_SCOPE_MCP_CLIENTS = new Set([
    'antigravity',
    'codex',
    'copilot',
    'cursor',
    'vscode',
]);
function requiresSingleMcpConfigScope(client) {
    return SINGLE_SCOPE_MCP_CLIENTS.has(client);
}
function oppositeScope(scope) {
    return scope === 'project' ? 'user' : 'project';
}
async function inspectOtherMcpConfigScope(options, client) {
    const otherScope = oppositeScope(options.scope);
    const currentTarget = resolveTarget(options, targetFor(client, options.scope));
    const otherTarget = resolveTarget({ ...options, scope: otherScope }, targetFor(client, otherScope));
    if (otherTarget.configPath === currentTarget.configPath) {
        return { path: otherTarget.configPath, status: 'absent' };
    }
    const otherConfig = await readText(otherTarget.configPath);
    if (otherConfig === undefined) {
        return { path: otherTarget.configPath, status: 'absent' };
    }
    try {
        return {
            path: otherTarget.configPath,
            status: hasBrainServerConfig(otherConfig, otherTarget) ? 'present' : 'absent',
        };
    }
    catch (error) {
        return {
            error: error instanceof Error ? error.message : String(error),
            path: otherTarget.configPath,
            status: 'invalid',
        };
    }
}
/** `remove` as an npx user can run it, like the init and doctor commands other messages print. */
function brainmcpRemoveCommand(client, scope) {
    return `npx --yes ${BRAINMCP_CLI_PACKAGE_SPEC} remove --client ${client} --scope ${scope}`;
}
async function assertSingleMcpConfigScope(options, clients) {
    for (const client of clients) {
        if (!requiresSingleMcpConfigScope(client))
            continue;
        const duplicate = await inspectOtherMcpConfigScope(options, client);
        if (duplicate.status === 'absent')
            continue;
        const otherScope = oppositeScope(options.scope);
        if (duplicate.status === 'invalid') {
            throw new CliConfigurationError(`Cannot inspect the existing ${clientLabel(client)} ${otherScope}-scope configuration at ${duplicate.path}: ${duplicate.error}`);
        }
        throw new CliConfigurationError(`Brain is already configured for ${clientLabel(client)} at ${duplicate.path} (${otherScope} scope). ` +
            `Keep it in exactly one scope: run \`${brainmcpRemoveCommand(client, otherScope)} --yes\`, then retry.`);
    }
}
function hasBrainServerConfig(config, target) {
    if (target.format === 'toml') {
        // Real header lines only (`[…]` or `[[…]]`); a commented-out header is absent.
        return splitTomlSections(config).some((section) => section.name === 'mcp_servers.brain');
    }
    // A blank JSON config configures nothing; it must not block init or remove.
    if (!config.trim())
        return false;
    const json = parseJsonc(config);
    const servers = json[target.rootKey];
    return Boolean(servers &&
        typeof servers === 'object' &&
        !Array.isArray(servers) &&
        Object.prototype.hasOwnProperty.call(servers, 'brain'));
}
function probeFailureDetail(error, timeoutMs) {
    if (error instanceof RequestDeadlineError)
        return `Request timed out after ${timeoutMs} ms`;
    if (!(error instanceof Error))
        return String(error);
    // undici reports transport failures, including a refused redirect, as
    // `fetch failed` with the reason (for example "unexpected redirect") as `cause`.
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function validateOAuthAuthorizationMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, detail: 'response was not valid authorization-server metadata' };
    }
    const metadata = value;
    const requiredScopes = [...BRAIN_MCP_INITIAL_SCOPES, 'offline_access'];
    const scopesSupported = metadata.scopes_supported;
    const valid = metadata.issuer === BRAIN_OAUTH_ISSUER &&
        metadata.authorization_endpoint === `${BRAIN_OAUTH_ISSUER}/oauth2/authorize` &&
        metadata.token_endpoint === `${BRAIN_OAUTH_ISSUER}/oauth2/token` &&
        metadata.registration_endpoint === `${BRAIN_OAUTH_ISSUER}/oauth2/register` &&
        metadata.authorization_response_iss_parameter_supported === true &&
        isStringArray(metadata.code_challenge_methods_supported) &&
        metadata.code_challenge_methods_supported.includes('S256') &&
        isStringArray(metadata.response_types_supported) &&
        metadata.response_types_supported.includes('code') &&
        isStringArray(metadata.grant_types_supported) &&
        metadata.grant_types_supported.includes('authorization_code') &&
        metadata.grant_types_supported.includes('refresh_token') &&
        isStringArray(scopesSupported) &&
        requiredScopes.every((scope) => scopesSupported.includes(scope));
    return valid
        ? { ok: true, detail: `${BRAIN_OAUTH_ISSUER} (PKCE, DCR, refresh)` }
        : {
            ok: false,
            detail: 'metadata must advertise the Brain issuer, authorize/token/register endpoints, S256 PKCE, code + refresh grants, iss, and Brain scopes',
        };
}
function validateOAuthProtectedResourceMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, detail: 'response was not valid protected-resource metadata' };
    }
    const metadata = value;
    const scopesSupported = metadata.scopes_supported;
    const valid = metadata.resource === BRAIN_MCP_ENDPOINT &&
        isStringArray(metadata.authorization_servers) &&
        metadata.authorization_servers.includes(BRAIN_OAUTH_ISSUER) &&
        isStringArray(scopesSupported) &&
        BRAIN_MCP_INITIAL_SCOPES.every((scope) => scopesSupported.includes(scope));
    return valid
        ? { ok: true, detail: BRAIN_MCP_ENDPOINT }
        : {
            ok: false,
            detail: 'metadata must identify the Brain resource, issuer, and initial read scopes',
        };
}
function describeMcpServerConfig(client, scope, server) {
    if (client === 'antigravity')
        return describeAntigravityServerConfig(server);
    if (!server || server.url !== BRAIN_MCP_ENDPOINT) {
        return { ok: false, detail: server?.url ?? 'brain server missing' };
    }
    if ((client === 'claude-code' || client === 'vscode' || client === 'copilot') && server.type !== 'http') {
        return { ok: false, detail: `${clientLabel(client)} requires type "http"` };
    }
    if (client === 'cursor' && server.auth?.CLIENT_ID !== MCP_OAUTH_CLIENT_IDS.cursor) {
        return {
            ok: false,
            detail: `Cursor requires auth.CLIENT_ID "${MCP_OAUTH_CLIENT_IDS.cursor}"`,
        };
    }
    if (client === 'generic' && server.auth?.CLIENT_ID !== MCP_OAUTH_CLIENT_IDS.generic) {
        return {
            ok: false,
            detail: `Generic MCP requires auth.CLIENT_ID "${MCP_OAUTH_CLIENT_IDS.generic}"`,
        };
    }
    if (client === 'copilot' &&
        scope === 'user' &&
        (!Array.isArray(server.tools) || !server.tools.includes('*'))) {
        return { ok: false, detail: 'GitHub Copilot CLI user config requires tools: ["*"]' };
    }
    return { ok: true, detail: server.url };
}
async function plannedChanges(options, client, workspace, mode, 
/** An enabled host plugin that replaces init's MCP entry and hooks (init only). */
plugin) {
    const target = resolveTarget(options, targetFor(client, options.scope));
    const [config, guidance] = await Promise.all([readText(target.configPath), readText(target.guidancePath)]);
    // With the plugin enabled, init still owns the guidance block but takes back
    // the MCP entry and hooks it wrote, so the host loads Brain only once.
    const configMode = mode === 'init' && plugin ? 'remove' : mode;
    // Codex skips plugin hooks until the user trusts them, so init keeps writing
    // its own hooks until then; each one stands aside once its plugin twin runs.
    // No plugin ships the write-back nudge, so a requested nudge stays beside a
    // plugin that runs every other hook ('nudge': only the nudge's hooks).
    const hookMode = mode === 'init' && plugin && isPluginHost(client) && !pluginRunsAllHooks(client, plugin)
        ? 'init'
        : mode === 'init' && keepsNudgeBesidePlugin(options, client, plugin) ? 'nudge' : configMode;
    let preserveSharedGuidance = false;
    let preserveSharedConfig = false;
    if (mode === 'remove') {
        // Some hosts deliberately share one instruction file (VS Code/Copilot at
        // user scope; Codex/generic at project scope). Removing one target must not
        // erase guidance while another distinct config still owns Brain.
        for (const siblingClient of BRAINMCP_CLI_CLIENTS) {
            if (siblingClient === client)
                continue;
            const siblingTarget = resolveTarget(options, targetFor(siblingClient, options.scope));
            if (siblingTarget.guidancePath !== target.guidancePath ||
                siblingTarget.configPath === target.configPath) {
                continue;
            }
            const siblingConfig = await readText(siblingTarget.configPath);
            if (siblingConfig !== undefined && hasBrainServerConfig(siblingConfig, siblingTarget)) {
                preserveSharedGuidance = true;
                break;
            }
        }
    }
    if (configMode === 'remove') {
        // Claude Code and Copilot CLI intentionally share the portable project
        // `.mcp.json` entry, whose schema is identical. Their separate managed
        // instruction files tell us whether the sibling setup still needs it.
        if (options.scope === 'project' &&
            (client === 'claude-code' || client === 'copilot')) {
            const siblingClient = client === 'claude-code' ? 'copilot' : 'claude-code';
            const siblingTarget = resolveTarget(options, targetFor(siblingClient, 'project'));
            const siblingGuidance = await readText(siblingTarget.guidancePath);
            preserveSharedConfig = Boolean(siblingGuidance?.includes('brainmcp:managed:start'));
        }
    }
    const changes = [
        {
            path: target.configPath,
            before: config,
            after: configMode === 'init'
                ? target.format === 'toml' ? upsertTomlBlock(config, client) : upsertJsonServer(config, client, target.rootKey, options.scope)
                : preserveSharedConfig
                    ? config
                    : target.format === 'toml' ? removeTomlBlock(config) : removeJsonServer(config, target.rootKey),
        },
        {
            path: target.guidancePath,
            before: guidance,
            after: mode === 'init'
                ? upsertGuidance(guidance, client, options.scope, workspace)
                : preserveSharedGuidance ? guidance : removeGuidance(guidance, client, options.scope),
        },
    ];
    if (client === 'antigravity' && options.scope === 'user') {
        const stalePath = join(options.home ?? homedir(), '.gemini/config/AGENTS.md');
        if (stalePath !== target.guidancePath) {
            const stale = await readText(stalePath);
            if (stale?.includes('brainmcp:managed:start')) {
                changes.push({
                    path: stalePath,
                    before: stale,
                    after: removeMarkdownBlock(stale),
                });
            }
        }
    }
    const hookChanges = await plannedHookChanges(options, client, target, hookMode);
    changes.push(...hookChanges);
    return changes;
}
/**
 * Where a host's hook config lives. Codex user scope already resolved an
 * absolute path under CODEX_HOME; any other path is relative to the user's home
 * or the project root. `isAbsolute` (not a leading `/`) keeps Windows drive and
 * UNC paths from being joined onto home a second time. `pathApi` exists so tests
 * can apply Windows rules on any platform.
 */
export function resolveHookFilePath(hookPath, input, pathApi = { isAbsolute, join, resolve }) {
    if (pathApi.isAbsolute(hookPath))
        return hookPath;
    return input.scope === 'user'
        ? pathApi.join(input.home, hookPath)
        : toAbsolute(input.root, hookPath, pathApi);
}
async function plannedHookChanges(options, client, target, mode) {
    if (!target.supportsHooks || !target.hookPath)
        return [];
    if (mode !== 'remove' && options.noHooks)
        return [];
    const home = options.home ?? homedir();
    const hookFilePath = resolveHookFilePath(target.hookPath, { scope: options.scope, home, root: options.root });
    const existingHook = await readText(hookFilePath);
    if (mode === 'remove') {
        const after = removeManagedHooksText(client, existingHook);
        return after === existingHook ? [] : [{ path: hookFilePath, before: existingHook, after }];
    }
    const bundle = loadPackagedRuntimeBundle();
    if (!bundle) {
        throw new CliConfigurationError('The packaged BrainMCP hook runtime is missing. Reinstall or rebuild the CLI before enabling hooks.');
    }
    const brainHome = brainHomeFor(options);
    const version = cliPackageVersion();
    const runtimePath = getVersionedRuntimePath(version, brainHome);
    // Hook commands name the version-independent shim, so they stay byte-identical
    // across upgrades (Codex re-asks for trust when a hook command changes). The
    // versioned runtime is written first; the shim then points at it.
    const shimPath = getRuntimeShimPath(brainHome);
    const changes = [];
    const existingRuntime = await readText(runtimePath);
    if (existingRuntime !== bundle) {
        // A generated bundle of about 4,000 lines: a diff would bury the config changes.
        changes.push({ path: runtimePath, before: existingRuntime, after: bundle, summarizePreview: true });
    }
    const shim = renderRuntimeShim(version);
    const existingShim = await readText(shimPath);
    if (existingShim !== shim) {
        changes.push({ path: shimPath, before: existingShim, after: shim, backup: false });
    }
    const parsed = existingHook?.trim() ? parseJsonc(existingHook) : {};
    const next = mode === 'nudge'
        ? upsertClaudeNudgeHooks(parsed, shimPath)
        : client === 'claude-code'
            ? upsertClaudeManagedHooks(parsed, shimPath, { enableNudge: Boolean(options.writeBackNudge) })
            : client === 'cursor'
                ? upsertCursorManagedHooks(parsed, shimPath)
                : client === 'codex'
                    ? upsertCodexManagedHooks(parsed, shimPath)
                    : upsertVsCodeManagedHooks(parsed, shimPath);
    const eventNames = client === 'claude-code'
        ? ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd', 'Stop']
        : client === 'cursor'
            ? ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'afterAgentResponse', 'preCompact', 'sessionEnd']
            : client === 'codex'
                ? ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd']
                : ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'];
    const nextHooks = hookMap(next);
    let after = existingHook ?? '{}\n';
    if (client === 'cursor') {
        after = upsertJsoncPath(after, ['version'], 1);
    }
    for (const eventName of eventNames) {
        const value = nextHooks[eventName];
        after = value === undefined
            ? removeJsoncPath(after, ['hooks', eventName])
            : upsertJsoncPath(after, ['hooks', eventName], value);
    }
    if (existingHook !== after) {
        changes.push({ path: hookFilePath, before: existingHook, after });
    }
    return changes;
}
function hookMap(root) {
    const hooks = root && typeof root === 'object' && !Array.isArray(root)
        ? root.hooks
        : undefined;
    return hooks && typeof hooks === 'object' && !Array.isArray(hooks)
        ? hooks
        : {};
}
/**
 * A hook file's text after `remove`. A missing or blank file, or one without a
 * BrainMCP-managed entry, is returned unchanged: remove never touches a file it
 * did not write to. Only events that lost a managed entry are rewritten, so
 * other hooks keep their text, and an emptied `hooks` object is dropped. The
 * file is deleted only when what remains is what init creates from nothing:
 * `{}`, or `{ "version": 1 }` for Cursor.
 */
function removeManagedHooksText(client, existing) {
    if (!existing?.trim())
        return existing;
    const parsed = parseJsonc(existing);
    const events = managedHookEvents(parsed);
    if (events.length === 0)
        return existing;
    const nextHooks = hookMap(client === 'claude-code'
        ? removeClaudeManagedHooks(parsed)
        : client === 'cursor'
            ? removeCursorManagedHooks(parsed)
            : client === 'codex'
                ? removeCodexManagedHooks(parsed)
                : removeVsCodeManagedHooks(parsed));
    let after = existing;
    for (const eventName of events) {
        const value = nextHooks[eventName];
        after = value === undefined
            ? removeJsoncPath(after, ['hooks', eventName])
            : upsertJsoncPath(after, ['hooks', eventName], value);
    }
    const remainder = parseJsonc(after);
    const remainingHooks = remainder.hooks;
    if (remainingHooks && typeof remainingHooks === 'object' && !Array.isArray(remainingHooks) &&
        Object.keys(remainingHooks).length === 0) {
        after = removeJsoncPath(after, ['hooks']);
        delete remainder.hooks;
    }
    const keys = Object.keys(remainder);
    const createdByInit = keys.length === 0 ||
        (client === 'cursor' && keys.length === 1 && remainder.version === 1);
    return createdByInit ? undefined : after;
}
function resolveTarget(options, target) {
    const home = options.home ?? homedir();
    if (options.scope === 'user' && target.client === 'codex') {
        const configuredCodexHome = (options.env ?? process.env).CODEX_HOME?.trim();
        const codexHome = configuredCodexHome ? resolve(configuredCodexHome) : join(home, '.codex');
        return {
            ...target,
            configPath: join(codexHome, 'config.toml'),
            guidancePath: join(codexHome, 'AGENTS.md'),
            hookPath: join(codexHome, 'hooks.json'),
            format: target.configFormat,
            rootKey: target.configRootKey,
        };
    }
    if (options.scope === 'user' && target.client === 'claude-code') {
        // With CLAUDE_CONFIG_DIR set, Claude Code keeps `.claude.json` in that
        // directory too, beside CLAUDE.md and settings.json; plugin detection and
        // the plugin hook's guidance check read the same directory.
        const env = options.env ?? process.env;
        const configDir = claudeConfigDir({ home, env });
        return {
            ...target,
            configPath: join(env.CLAUDE_CONFIG_DIR?.trim() ? configDir : home, '.claude.json'),
            guidancePath: join(configDir, 'CLAUDE.md'),
            hookPath: join(configDir, 'settings.json'),
            format: target.configFormat,
            rootKey: target.configRootKey,
        };
    }
    const base = options.scope === 'user' ? home : options.root;
    return {
        ...target,
        configPath: options.scope === 'user' && target.client === 'vscode'
            ? vscodeUserConfigPath(home, options.env ?? process.env, options.platform ?? process.platform)
            : toAbsolute(base, target.configPath),
        guidancePath: toAbsolute(base, target.guidancePath),
        format: target.configFormat,
        rootKey: target.configRootKey,
    };
}
/**
 * VS Code's default user-profile `mcp.json`. Other Unix-like platforms follow
 * the XDG base directory spec, which says to ignore a relative
 * `XDG_CONFIG_HOME`. `pathApi` exists so tests can apply Windows rules on any
 * platform.
 */
export function vscodeUserConfigPath(home, env, platform, pathApi = { isAbsolute, join }) {
    if (platform === 'win32') {
        return pathApi.join(env.APPDATA?.trim() || pathApi.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
    }
    if (platform === 'darwin') {
        return pathApi.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    }
    const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
    return pathApi.join(xdgConfigHome && pathApi.isAbsolute(xdgConfigHome) ? xdgConfigHome : pathApi.join(home, '.config'), 'Code', 'User', 'mcp.json');
}
function upsertGuidance(existing, client, scope, workspace) {
    const preamble = guidancePreamble(client, scope);
    // A guidance refresh must not silently unbind a project. Explicit --workspace
    // still replaces the old binding. Validate markers before trusting their text.
    const normalized = existing?.replace(/\r\n/g, '\n');
    const block = normalized?.match(/<!-- brainmcp:managed:start[^\n]*-->[\s\S]*?<!-- brainmcp:managed:end -->/)?.[0];
    const boundWorkspace = workspace ?? block?.match(/^Workspace id: (.+)$/m)?.[1]?.trim();
    const updated = upsertMarkdownBlock(normalized, renderGuidance(client, boundWorkspace));
    if (preamble) {
        if (!block)
            return `${preamble}\n\n${renderGuidance(client, workspace)}`;
        // These are dedicated Brain files, so refresh the owned header while keeping
        // user text outside a valid managed block. Old duplicated headers collapse.
        const collapsed = collapseGeneratedPreambles(updated, preamble);
        const body = collapsed.replace(/^---\n[\s\S]*?\n---\n*/, '');
        return `${preamble}\n\n${body}`;
    }
    return updated;
}
function removeGuidance(existing, client, scope) {
    const preamble = guidancePreamble(client, scope);
    const removed = removeMarkdownBlock(existing);
    const normalized = preamble && removed
        ? collapseGeneratedPreambles(removed, preamble)
        : removed;
    return preamble && normalized?.trim() === preamble.trim() ? undefined : normalized;
}
function collapseGeneratedPreambles(text, preamble) {
    const prefix = `${preamble.trimEnd()}\n\n`;
    let remainder = text;
    let count = 0;
    while (remainder.startsWith(prefix)) {
        remainder = remainder.slice(prefix.length);
        count += 1;
    }
    return count > 0 ? `${prefix}${remainder}` : text;
}
function mergeFileChanges(changes) {
    const merged = new Map();
    for (const change of changes) {
        const previous = merged.get(change.path);
        if (!previous) {
            merged.set(change.path, change);
            continue;
        }
        if (previous.before !== change.before || previous.after !== change.after) {
            throw new Error(`Conflicting planned changes for ${change.path}. Configure clients individually.`);
        }
    }
    return [...merged.values()];
}
/** The generated hook runtime previews as one line (size and SHA-256); it is still written in full. */
function renderRuntimeSummary(change) {
    const content = change.after ?? '';
    const bytes = Buffer.byteLength(content, 'utf8');
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    return `+++ ${change.path} (${change.before === undefined ? 'new' : 'updated'} BrainMCP hook runtime, ${bytes} bytes, sha256 ${sha256})`;
}
/**
 * Every planned JSON/JSONC file must still parse. The edits keep the user's
 * comments and formatting, so a slip there would otherwise write a host config
 * that the host, and every later `init`, `doctor` and `remove`, cannot read.
 */
export function assertPlannedJsonParses(changes) {
    for (const change of changes) {
        if (change.after === undefined || !/\.jsonc?$/i.test(change.path))
            continue;
        try {
            parseJsonc(change.after);
        }
        catch {
            throw new CliConfigurationError(`Refusing to write ${change.path}: the planned edit is not valid JSON/JSONC. No file was changed.`);
        }
    }
}
async function previewAndApply(changes, options) {
    const changed = changes.filter((change) => change.before !== change.after);
    if (!changed.length) {
        options.output('BrainMCP configuration is already up to date.');
        return;
    }
    assertPlannedJsonParses(changed);
    options.output(changed.map((change) => change.summarizePreview ? renderRuntimeSummary(change) : renderDiff(change)).join('\n\n'));
    if (!options.yes && !(await options.confirm?.('Apply these changes?') ?? false)) {
        throw new Error('Aborted. Re-run with --yes after reviewing the preview.');
    }
    const brainHome = brainHomeFor(options);
    const { backups, cleanInGit } = await applyChanges(changed, { brainHome });
    options.output(['Applied changes with atomic per-file writes.', ...renderBackupReport(backups, cleanInGit, brainHome)].join('\n'));
}
/** The brain home init, doctor and remove use: `<home>/.brainmcp` under a test home, else BRAINMCP_HOME or `~/.brainmcp`. */
function brainHomeFor(options) {
    return options.home ? join(options.home, '.brainmcp') : getBrainHome();
}
export function renderBackupReport(backups, cleanInGit, brainHome) {
    const lines = [];
    if (backups.length) {
        lines.push(`Backups (to undo, copy one back over its file; kept in ${getBackupsDir(brainHome)} for ${BACKUP_MAX_AGE_MS / 86_400_000} days, at most ${BACKUP_MAX_PER_FILE} per file):`, ...backups.map(({ path, backup }) => `  ${path} <- ${backup}`));
    }
    if (cleanInGit.length) {
        lines.push('Not backed up because they were clean in Git (to undo, restore the committed version with `git restore <file>`):', ...cleanInGit.map((path) => `  ${path}`));
    }
    return lines;
}
export * from './auth.js';
export * from './dispatch.js';
//# sourceMappingURL=index.js.map