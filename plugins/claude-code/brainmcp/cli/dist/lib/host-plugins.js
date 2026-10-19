import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BRAINMCP_PLUGIN_NAME } from '../agent-config.js';
export function isPluginHost(client) {
    return client === 'claude-code' || client === 'codex';
}
/** The lifecycle events the Claude Code and Codex plugins ship hooks for. */
export const PLUGIN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd'];
/** Codex's config-state label for a hook event (`codex-rs/hooks/src/lib.rs` `hook_event_key_label`). */
export function codexHookEventLabel(event) {
    return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
/**
 * Whether the host runs this plugin's own hook for `event`. A plugin ships no
 * Stop nudge, and Codex skips a plugin hook until the user trusts it, so a hook
 * `init` wrote must keep running in either case.
 */
export function pluginRunsHook(host, install, event) {
    if (!install.enabled || !PLUGIN_HOOK_EVENTS.includes(event))
        return false;
    if (host === 'claude-code')
        return true;
    return install.trustedHookEvents?.includes(codexHookEventLabel(event)) ?? false;
}
/** Whether every hook the plugin ships runs, so `init`'s own hooks are redundant. */
export function pluginRunsAllHooks(host, install) {
    return PLUGIN_HOOK_EVENTS.every((event) => pluginRunsHook(host, install, event));
}
function readJson(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
function isBrainmcpPluginId(id) {
    return id.startsWith(`${BRAINMCP_PLUGIN_NAME}@`) && id.length > BRAINMCP_PLUGIN_NAME.length + 1;
}
function samePath(a, b) {
    return Boolean(a && b) && resolve(a) === resolve(b);
}
/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(lookup = {}) {
    const configured = (lookup.env ?? process.env).CLAUDE_CONFIG_DIR?.trim();
    return configured ? resolve(configured) : join(lookup.home ?? homedir(), '.claude');
}
/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export function codexHomeDir(lookup = {}) {
    const configured = (lookup.env ?? process.env).CODEX_HOME?.trim();
    return configured ? resolve(configured) : join(lookup.home ?? homedir(), '.codex');
}
/**
 * Claude Code records installs in `plugins/installed_plugins.json` (version 2:
 * `plugins["name@marketplace"]` is a list of `{ scope, version, projectPath? }`)
 * and enablement in each scope's settings `enabledPlugins`, where local beats
 * project beats user. An install the user never toggled is enabled, because
 * `claude plugin install` writes `true` and `defaultEnabled` defaults to true.
 */
export function detectClaudeCodePlugin(lookup = {}) {
    const configDir = claudeConfigDir(lookup);
    const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'));
    const plugins = installed?.plugins && typeof installed.plugins === 'object' && !Array.isArray(installed.plugins)
        ? installed.plugins
        : {};
    const settings = [
        lookup.root ? readJson(join(lookup.root, '.claude', 'settings.local.json')) : undefined,
        lookup.root ? readJson(join(lookup.root, '.claude', 'settings.json')) : undefined,
        readJson(join(configDir, 'settings.json')),
    ];
    const enabledFor = (pluginId) => {
        for (const scope of settings) {
            const enabledPlugins = scope?.enabledPlugins;
            if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins))
                continue;
            const value = enabledPlugins[pluginId];
            if (typeof value === 'boolean')
                return value;
        }
        return true;
    };
    const installs = [];
    for (const [pluginId, records] of Object.entries(plugins)) {
        if (!isBrainmcpPluginId(pluginId) || !Array.isArray(records))
            continue;
        for (const record of records) {
            if (!record || typeof record !== 'object')
                continue;
            const { scope, projectPath, version } = record;
            const applies = scope === 'user' ||
                ((scope === 'project' || scope === 'local') && typeof projectPath === 'string' && samePath(projectPath, lookup.root));
            if (!applies)
                continue;
            installs.push({
                pluginId,
                scope: scope,
                version: typeof version === 'string' ? version : undefined,
                enabled: enabledFor(pluginId),
            });
        }
    }
    return { host: 'claude-code', installs, active: installs.find((install) => install.enabled) };
}
/**
 * Reads plugin tables and hook trust state from Codex's `config.toml`.
 *
 * Hook trust lives there as `[hooks.state."<key>"]` with `trusted_hash` and an
 * optional `enabled = false`. The key is `<key source>:<event label>:<group>:<handler>`
 * (`hook_key` in codex-rs/hooks/src/lib.rs); the key source is
 * `<plugin id>:hooks/hooks.json` for a plugin's hooks and the hooks.json path
 * for a user or project one (`key_source` in codex-rs/hooks/src/engine/discovery.rs,
 * openai/codex f529722).
 *
 * Limitation: this reads only that a trust hash is recorded. Codex runs a hook
 * only while that hash equals `hook_hash` of its current definition, and shows
 * it as "Modified" otherwise. `hook_hash` is "sha256:" plus the hex SHA-256 of
 * compact JSON, keys sorted at every level (`version_for_toml` in
 * codex-rs/config/src/fingerprint.rs), of `{ event_name: <event label>,
 * matcher: <matcher, omitted when the event ignores it>, hooks: [<handler with
 * the unsubstituted command, no commandWindows, the timeout after Codex's
 * defaults and SessionEnd clamp, async, statusMessage, additionalContextLimit
 * when not the default>] }`, serialized through a TOML value. That can be
 * reproduced, but no hash written by a real Codex has been checked against it
 * yet (plan rows B3 and PLG-403), so a stale record still reads as trusted here.
 * Keeping hook commands byte-stable across releases (the runtime shim) keeps
 * such records valid.
 */
function parseCodexConfig(config) {
    const installs = [];
    const hookStates = new Map();
    let current;
    let currentHook;
    for (const line of config.split(/\r?\n/)) {
        const header = line.match(/^\s*\[\s*plugins\s*\.\s*"([^"]+)"\s*\]\s*(?:#.*)?$/);
        if (header) {
            currentHook = undefined;
            current = isBrainmcpPluginId(header[1])
                ? { pluginId: header[1], scope: 'user', enabled: true }
                : undefined;
            if (current)
                installs.push(current);
            continue;
        }
        // A Windows path key needs escapes in a basic string, or a literal string.
        const hookHeader = line.match(/^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)+)"|'([^']+)')\s*\]\s*(?:#.*)?$/);
        if (hookHeader) {
            current = undefined;
            currentHook = { trusted: false, disabled: false };
            hookStates.set(hookHeader[1] !== undefined ? unescapeTomlBasicString(hookHeader[1]) : hookHeader[2], currentHook);
            continue;
        }
        if (/^\s*\[/.test(line)) {
            current = undefined;
            currentHook = undefined;
            continue;
        }
        const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
        if (current && enabled)
            current.enabled = enabled[1] === 'true';
        if (currentHook && enabled)
            currentHook.disabled = enabled[1] === 'false';
        if (currentHook && /^\s*trusted_hash\s*=\s*"[^"]+"/.test(line))
            currentHook.trusted = true;
    }
    return { installs, hookStates };
}
const TOML_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
function unescapeTomlBasicString(value) {
    return value.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (escape, code) => code.length > 1 ? String.fromCodePoint(Number.parseInt(code.slice(1), 16)) : TOML_ESCAPES[code] ?? escape);
}
/** Hook trust state recorded in Codex's `config.toml` (see `parseCodexConfig`). */
export function readCodexHookStates(lookup = {}) {
    return parseCodexConfig(readText(join(codexHomeDir(lookup), 'config.toml')) ?? '').hookStates;
}
/**
 * Codex records an installed plugin as `[plugins."name@marketplace"]` in
 * `$CODEX_HOME/config.toml` (`enabled = true` after `codex plugin add`) and
 * caches it under `plugins/cache/<marketplace>/<name>/<version>/`. Plugins are
 * user-level, so every project sees the same state. Hook trust is read from the
 * same file (`parseCodexConfig`).
 */
export function detectCodexPlugin(lookup = {}) {
    const codexHome = codexHomeDir(lookup);
    const { installs, hookStates } = parseCodexConfig(readText(join(codexHome, 'config.toml')) ?? '');
    for (const install of installs) {
        const [name, marketplace] = install.pluginId.split('@');
        const cacheDir = join(codexHome, 'plugins', 'cache', marketplace, name);
        install.version = installedCodexVersion(cacheDir);
        const shipped = install.version ? codexHookHandlers(readJson(join(cacheDir, install.version, 'hooks', 'hooks.json'))) : undefined;
        install.trustedHookEvents = trustedCodexHookEvents(install.pluginId, hookStates, shipped);
    }
    return { host: 'codex', installs, active: installs.find((install) => install.enabled) };
}
/**
 * Every handler a nested hooks.json defines, numbered as Codex numbers them:
 * group and handler indexes are raw array positions.
 */
export function codexHookHandlers(hooksJson) {
    const hooks = hooksJson?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return undefined;
    const positions = [];
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups))
            continue;
        groups.forEach((group, groupIndex) => {
            const handlers = group && typeof group === 'object' ? group.hooks : undefined;
            if (!Array.isArray(handlers))
                return;
            handlers.forEach((_handler, handlerIndex) => {
                positions.push({ event: codexHookEventLabel(event), group: groupIndex, handler: handlerIndex });
            });
        });
    }
    return positions;
}
/**
 * Events for which Codex runs every handler the plugin ships: each has a
 * recorded trust hash and is not disabled. `shipped` comes from the installed
 * plugin's hooks.json; without it, each shipped event is assumed to be one
 * handler at group 0, handler 0, as BrainMCP's plugin ships them.
 */
function trustedCodexHookEvents(pluginId, hookStates, shipped) {
    const handlers = shipped ?? PLUGIN_HOOK_EVENTS.map((event) => ({ event: codexHookEventLabel(event), group: 0, handler: 0 }));
    const states = [...hookStates].filter(([key]) => key.startsWith(`${pluginId}:`));
    const byEvent = new Map();
    for (const { event, group, handler } of handlers) {
        const suffix = `:${event}:${group}:${handler}`;
        const matching = states.filter(([key]) => key.endsWith(suffix)).map(([, state]) => state);
        const runs = matching.length > 0 && matching.every((state) => state.trusted && !state.disabled);
        byEvent.set(event, (byEvent.get(event) ?? true) && runs);
    }
    return [...byEvent].filter(([, runs]) => runs).map(([event]) => event).sort();
}
/**
 * Codex trust-gates the hooks in a user or project hooks.json exactly like a
 * plugin's, keyed by that file's path. `positions` are the managed handlers in
 * it (event names as in the file). Codex may record the path as resolved or
 * with symlinks resolved (macOS `/var` is `/private/var`), so both count.
 */
export function codexManagedHookTrust(hookFilePath, positions, lookup = {}) {
    const hookStates = readCodexHookStates(lookup);
    const sources = new Set([resolve(hookFilePath)]);
    try {
        sources.add(realpathSync(hookFilePath));
    }
    catch {
        // A missing file has no other spelling.
    }
    const byEvent = new Map();
    for (const { event, group, handler } of positions) {
        const states = [...sources]
            .map((source) => hookStates.get(`${source}:${codexHookEventLabel(event)}:${group}:${handler}`))
            .filter((state) => state !== undefined);
        const status = states.some((state) => state.disabled)
            ? 'disabled'
            : states.some((state) => state.trusted) ? 'trusted' : 'untrusted';
        const previous = byEvent.get(event);
        // Worst status wins: disabled, then untrusted, then trusted.
        if (previous === 'disabled' || (previous === 'untrusted' && status === 'trusted'))
            continue;
        byEvent.set(event, status);
    }
    const of = (status) => [...byEvent].filter(([, value]) => value === status).map(([event]) => event);
    return { trusted: of('trusted'), untrusted: of('untrusted'), disabled: of('disabled') };
}
function installedCodexVersion(cacheDir) {
    try {
        // Codex activates one version and removes the others, so one entry remains.
        const versions = readdirSync(cacheDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name);
        return versions.length === 1 ? versions[0] : undefined;
    }
    catch {
        return undefined;
    }
}
export function detectHostPlugin(host, lookup = {}) {
    return host === 'claude-code' ? detectClaudeCodePlugin(lookup) : detectCodexPlugin(lookup);
}
/**
 * The enabled BrainMCP plugin that would duplicate what `init` writes at this
 * scope. A user-scope `init` serves every project, so only a user-scope plugin
 * replaces it. A project-scope `init` writes files a team commits (`.mcp.json`,
 * `.claude/settings.json`, `.codex/config.toml`), so only a project- or
 * local-scope install replaces it: one person's user-scope plugin must not
 * strip them for teammates who lack it. For that person, the committed hooks
 * still stand aside while the plugin's hooks run (`managedHookYieldsToPlugin`).
 */
export function pluginReplacingInit(host, scope, lookup) {
    const status = detectHostPlugin(host, lookup);
    return status.installs.find((install) => install.enabled && (scope === 'project') === (install.scope !== 'user'));
}
export function describePluginInstall(host, install) {
    const label = host === 'claude-code' ? 'Claude Code' : 'Codex';
    return `${label} plugin ${install.pluginId}${install.version ? ` ${install.version}` : ''} (${install.scope} scope)`;
}
//# sourceMappingURL=host-plugins.js.map