import { escapeShellArg } from '../agent-config.js';
/**
 * Marks a hook command `init` wrote. It is stable on purpose, like the runtime
 * shim the command runs (`getRuntimeShimPath`): Codex trusts a hook by a hash
 * over its command, so a command that changed with the CLI or guidance version
 * would be skipped as "Modified" after every upgrade until trusted again.
 * Removal still recognizes every earlier `brainmcp:managed:hook:v*` tag.
 */
export const HOOK_MANAGED_TAG = 'brainmcp:managed:hook:v1';
const MANAGED_RUNTIME_BASENAME = 'brainmcp-hook-runtime.mjs';
/** Build a host-valid command whose managed marker does not rely on an unknown JSON key. */
export function buildHookCommand(runtimePath, host, event, options) {
    const mode = options?.nudgeLedger ? ' --nudge-ledger' : '';
    if (!/^[a-z-]+$/.test(host) || !/^[A-Za-z]+$/.test(event))
        throw new Error('Invalid managed hook host or event.');
    if (process.platform === 'win32' && /[%!"\r\n]/.test(runtimePath))
        throw new Error('The Windows hook runtime path contains shell expansion characters. Choose a BRAINMCP_HOME without them.');
    const quotedPath = process.platform === 'win32' ? `"${runtimePath}"` : escapeShellArg(runtimePath);
    return `node ${quotedPath} ${host} ${event}${mode} --managed-tag=${HOOK_MANAGED_TAG}`;
}
function objectRoot(existingJson, defaults = {}) {
    return existingJson && typeof existingJson === 'object' && !Array.isArray(existingJson)
        ? { ...existingJson }
        : { ...defaults };
}
function managedCommandGroup(runtimePath, host, event, extra, handlerOptions) {
    const { timeout, ...commandOptions } = handlerOptions ?? {};
    return {
        ...extra,
        hooks: [{
                type: 'command',
                command: buildHookCommand(runtimePath, host, event, commandOptions),
                ...(timeout === undefined ? {} : { timeout }),
            }],
    };
}
function stripManagedEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return entry;
    if (Array.isArray(entry.hooks)) {
        const hooks = entry.hooks.filter((handler) => !isManagedBrainMcpEntry({ ...handler, _managed: entry._managed }));
        return hooks.length ? { ...entry, hooks } : null;
    }
    return isManagedBrainMcpEntry(entry) ? null : entry;
}
/** Whether `stripManagedEntry` would remove anything from this entry. */
function holdsManagedEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return false;
    const record = entry;
    if (Array.isArray(record.hooks)) {
        return record.hooks.some((handler) => isManagedBrainMcpEntry({ ...handler, _managed: record._managed }));
    }
    return isManagedBrainMcpEntry(record);
}
/**
 * Hook events holding at least one BrainMCP-managed entry, flat or nested. It
 * recognizes the same entries removal strips, including the legacy `_managed`
 * marker and any `brainmcp:managed:hook:v*` tag.
 */
export function managedHookEvents(existingJson) {
    if (!existingJson || typeof existingJson !== 'object' || Array.isArray(existingJson))
        return [];
    const hooks = existingJson.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return [];
    return Object.entries(hooks)
        .filter(([, entries]) => Array.isArray(entries) && entries.some(holdsManagedEntry))
        .map(([event]) => event);
}
/** True when a hook config holds anything BrainMCP installed, so `remove` may touch it. */
export function containsManagedHooks(existingJson) {
    return managedHookEvents(existingJson).length > 0;
}
function replaceManagedEntries(entries, replacement) {
    const kept = Array.isArray(entries) ? entries.map(stripManagedEntry).filter((entry) => entry !== null) : [];
    if (replacement)
        kept.push(replacement);
    return kept;
}
function cleanEmptyHooks(root, hooks) {
    if (Object.keys(hooks).length === 0)
        delete root.hooks;
    else
        root.hooks = hooks;
    return root;
}
/** Upsert orientation plus dormant capture boundaries and an optional nudge ledger. */
export function upsertClaudeManagedHooks(existingJson, runtimePath, options) {
    const root = objectRoot(existingJson);
    const hooks = objectRoot(root.hooks);
    hooks.SessionStart = replaceManagedEntries(hooks.SessionStart, managedCommandGroup(runtimePath, 'claude-code', 'SessionStart', {
        matcher: 'startup|resume|clear|compact|fork',
    }));
    const stopEntries = replaceManagedEntries(hooks.Stop, options?.enableNudge
        ? managedCommandGroup(runtimePath, 'claude-code', 'StopNudge')
        : undefined);
    if (stopEntries.length > 0)
        hooks.Stop = stopEntries;
    else
        delete hooks.Stop;
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd']) {
        hooks[event] = replaceManagedEntries(hooks[event], managedCommandGroup(runtimePath, 'claude-code', event, undefined, options?.enableNudge && (event === 'UserPromptSubmit' || event === 'PostToolUse')
            ? { nudgeLedger: true }
            : undefined));
    }
    root.hooks = hooks;
    return root;
}
export function removeClaudeManagedHooks(existingJson) {
    return removeManagedHooks(existingJson);
}
/** The Claude Code events whose managed hooks make up the write-back nudge. */
export const CLAUDE_NUDGE_HOOK_EVENTS = ['Stop', 'UserPromptSubmit', 'PostToolUse'];
/**
 * Only the write-back nudge, for a Claude Code setup whose BrainMCP plugin runs
 * the lifecycle hooks. No plugin ships the nudge, so it keeps the Stop nudge
 * and the `--nudge-ledger` UserPromptSubmit and PostToolUse hooks that count
 * activity for it, and removes init's other managed hooks. The runtime keeps
 * those two recording content-free counters while capture is off and makes
 * them stand aside for the plugin's hooks while capture is on, so they never
 * duplicate the plugin's capture.
 */
export function upsertClaudeNudgeHooks(existingJson, runtimePath) {
    const root = objectRoot(existingJson);
    const hooks = objectRoot(root.hooks);
    for (const event of ['SessionStart', 'PreCompact', 'SessionEnd']) {
        if (!Array.isArray(hooks[event]) || !hooks[event].some(holdsManagedEntry))
            continue;
        const kept = replaceManagedEntries(hooks[event]);
        if (kept.length > 0)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    hooks.Stop = replaceManagedEntries(hooks.Stop, managedCommandGroup(runtimePath, 'claude-code', 'StopNudge'));
    for (const event of ['UserPromptSubmit', 'PostToolUse']) {
        hooks[event] = replaceManagedEntries(hooks[event], managedCommandGroup(runtimePath, 'claude-code', event, undefined, { nudgeLedger: true }));
    }
    return cleanEmptyHooks(root, hooks);
}
/**
 * Whether a managed command belongs to the write-back nudge: the Stop nudge,
 * or a `--nudge-ledger` hook. Beside an enabled plugin these are not duplicate
 * capture hooks (see `upsertClaudeNudgeHooks`).
 */
function isNudgeCommand(command) {
    return / StopNudge(?:\s|$)/.test(command) || /(?:^|\s)--nudge-ledger(?:\s|$)/.test(command);
}
/**
 * Managed hook events holding an entry that is not part of the write-back
 * nudge: the hooks that would duplicate an enabled plugin's.
 */
export function managedNonNudgeHookEvents(existingJson) {
    if (!existingJson || typeof existingJson !== 'object' || Array.isArray(existingJson))
        return [];
    const hooks = existingJson.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return [];
    return Object.entries(hooks)
        .filter(([, entries]) => Array.isArray(entries) && entries.some((entry) => managedHandlers(entry).some((handler) => !commandsIn(handler).every(isNudgeCommand))))
        .map(([event]) => event);
}
/** The managed handlers of one hook entry (a nested group or a flat handler). */
function managedHandlers(entry) {
    if (!entry || typeof entry !== 'object')
        return [];
    const record = entry;
    if (Array.isArray(record.hooks)) {
        return record.hooks.filter((handler) => isManagedBrainMcpEntry({ ...handler, _managed: record._managed }));
    }
    return isManagedBrainMcpEntry(record) ? [record] : [];
}
/**
 * Where each managed handler sits in a nested hooks file: event, group index,
 * and handler index, as Codex numbers them in its hook trust keys.
 */
export function managedHookPositions(existingJson) {
    if (!existingJson || typeof existingJson !== 'object' || Array.isArray(existingJson))
        return [];
    const hooks = existingJson.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return [];
    const positions = [];
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups))
            continue;
        groups.forEach((group, groupIndex) => {
            const record = group && typeof group === 'object' ? group : undefined;
            if (!record || !Array.isArray(record.hooks))
                return;
            record.hooks.forEach((handler, handlerIndex) => {
                if (isManagedBrainMcpEntry({ ...handler, _managed: record._managed })) {
                    positions.push({ event, group: groupIndex, handler: handlerIndex });
                }
            });
        });
    }
    return positions;
}
/** Cursor schema v1 uses arrays of flat command entries. */
export function upsertCursorManagedHooks(existingJson, runtimePath) {
    const root = objectRoot(existingJson, { version: 1 });
    root.version = 1;
    const hooks = objectRoot(root.hooks);
    hooks.sessionStart = replaceManagedEntries(hooks.sessionStart, {
        command: buildHookCommand(runtimePath, 'cursor', 'sessionStart'),
    });
    hooks.beforeSubmitPrompt = replaceManagedEntries(hooks.beforeSubmitPrompt, {
        command: buildHookCommand(runtimePath, 'cursor', 'beforeSubmitPrompt'),
    });
    for (const event of ['postToolUse', 'afterAgentResponse', 'preCompact', 'sessionEnd']) {
        hooks[event] = replaceManagedEntries(hooks[event], {
            command: buildHookCommand(runtimePath, 'cursor', event),
        });
    }
    root.hooks = hooks;
    return root;
}
export function removeCursorManagedHooks(existingJson) {
    return removeManagedHooks(existingJson);
}
/**
 * Codex uses the official nested event/group/handler hooks.json shape. Its
 * handler `timeout` is whole seconds. Without one, Codex gives SessionEnd 1 s
 * (clamped to 1–3 s) and every other event 600 s
 * (codex-rs/hooks/src/engine/discovery.rs), and on timeout it kills the hook's
 * process group.
 */
export function upsertCodexManagedHooks(existingJson, runtimePath) {
    const root = objectRoot(existingJson);
    const hooks = objectRoot(root.hooks);
    // No timeout: after sending a refresh token, the runtime outlives its
    // SessionStart deadline for up to the OAuth timeout to persist the rotated
    // token (api-client.ts). A host kill there would strand the grant.
    hooks.SessionStart = replaceManagedEntries(hooks.SessionStart, managedCommandGroup(runtimePath, 'codex', 'SessionStart', {
        matcher: 'startup|resume|clear|compact',
    }));
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd']) {
        // Seconds, above the runtime deadline (1.5 s, or 2.5 s for SessionEnd).
        // SessionEnd takes Codex's 3 s maximum; its 1 s default cuts the capture short.
        hooks[event] = replaceManagedEntries(hooks[event], managedCommandGroup(runtimePath, 'codex', event, undefined, {
            timeout: event === 'SessionEnd' ? 3 : 2,
        }));
    }
    root.hooks = hooks;
    return root;
}
export function removeCodexManagedHooks(existingJson) {
    return removeManagedHooks(existingJson);
}
/** VS Code hook files use flat command arrays under `hooks`. */
export function upsertVsCodeManagedHooks(existingJson, runtimePath) {
    const root = objectRoot(existingJson);
    const hooks = objectRoot(root.hooks);
    // Seconds. Must exceed the runtime's SessionStart deadline (up to 8 s after a
    // token refresh, plus 0.5 s of input headroom) and, as for Codex, the OAuth
    // timeout a sent refresh may outlive it by, so a host kill never drops an
    // answer or strands a rotated refresh token. The hook exits as soon as it
    // answers; only a slow refresh keeps it running that long.
    hooks.SessionStart = replaceManagedEntries(hooks.SessionStart, {
        type: 'command',
        command: buildHookCommand(runtimePath, 'vscode', 'SessionStart'),
        timeout: 19,
    });
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PreCompact']) {
        hooks[event] = replaceManagedEntries(hooks[event], {
            type: 'command',
            command: buildHookCommand(runtimePath, 'vscode', event),
            timeout: 2,
        });
    }
    root.hooks = hooks;
    return root;
}
export function removeVsCodeManagedHooks(existingJson) {
    return removeManagedHooks(existingJson);
}
function removeManagedHooks(existingJson) {
    if (!existingJson || typeof existingJson !== 'object' || Array.isArray(existingJson))
        return existingJson;
    const root = objectRoot(existingJson);
    const hooks = objectRoot(root.hooks);
    for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries))
            continue;
        const kept = entries.map(stripManagedEntry).filter((entry) => entry !== null);
        if (kept.length > 0)
            hooks[event] = kept;
        else
            delete hooks[event];
    }
    return cleanEmptyHooks(root, hooks);
}
function commandsIn(entry) {
    if (!entry || typeof entry !== 'object')
        return [];
    const record = entry;
    const direct = typeof record.command === 'string' ? [record.command] : [];
    const nested = Array.isArray(record.hooks)
        ? record.hooks.flatMap((handler) => commandsIn(handler))
        : [];
    return [...direct, ...nested];
}
/** A managed entry requires both a versioned marker and the runtime command path. */
export function isManagedBrainMcpEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return false;
    const legacyMarker = entry._managed;
    return commandsIn(entry).some((command) => {
        const normalized = command.trim().replace(/\\/g, '/').replace(/\s+/g, ' ');
        const hasRuntime = normalized.includes(`/${MANAGED_RUNTIME_BASENAME}\"`) ||
            normalized.includes(`/${MANAGED_RUNTIME_BASENAME}'`) ||
            normalized.includes(`/${MANAGED_RUNTIME_BASENAME} `);
        const hasCommandMarker = /(?:^|\s)--managed-tag=brainmcp:managed:hook:v[^\s]+(?:\s|$)/.test(normalized);
        const hasLegacyMarker = typeof legacyMarker === 'string' && /^brainmcp:managed:hook:v[^\s]+$/.test(legacyMarker);
        return hasRuntime && (hasCommandMarker || hasLegacyMarker);
    });
}
//# sourceMappingURL=managed-hooks.js.map