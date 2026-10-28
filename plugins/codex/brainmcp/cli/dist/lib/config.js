import { BRAIN_MCP_ENDPOINT, BRAINMCP_CLI_CLIENTS, GUIDANCE_VERSION, MCP_CLIENT_PROFILES, MCP_OAUTH_CLIENT_IDS, ANTIGRAVITY_RULES_FRONTMATTER, VSCODE_USER_INSTRUCTIONS_FRONTMATTER, buildCodexConfigToml, buildProjectInstructionBlock, renderCursorMdc, } from '../agent-config.js';
import { isWorkspaceUuid, normalizeWorkspaceId } from './cli-contracts.js';
export const BRAIN_ENDPOINT = BRAIN_MCP_ENDPOINT;
export const CLIENT_IDS = BRAINMCP_CLI_CLIENTS;
export function assertClientId(value) {
    if (CLIENT_IDS.includes(value))
        return value;
    throw new Error(`Unknown --client "${value}". Expected one of: ${CLIENT_IDS.join(', ')}.`);
}
export const MARKER_START = `<!-- brainmcp:managed:start version=${GUIDANCE_VERSION} -->`;
export const MARKER_END = '<!-- brainmcp:managed:end -->';
export const TOML_MARKER_START = `# brainmcp:managed:start version=${GUIDANCE_VERSION}`;
export const TOML_MARKER_END = '# brainmcp:managed:end';
export function targetFor(client, scope) {
    const home = scope === 'user';
    switch (client) {
        case 'cursor':
            return {
                client,
                configPath: '.cursor/mcp.json',
                guidancePath: '.cursor/rules/brainmcp-workspace.mdc',
                hookPath: '.cursor/hooks.json',
                supportsHooks: true,
                configFormat: 'jsonc',
                configRootKey: 'mcpServers',
            };
        case 'claude-code':
            return {
                client,
                configPath: home ? '.claude.json' : '.mcp.json',
                guidancePath: home ? '.claude/CLAUDE.md' : 'CLAUDE.md',
                hookPath: '.claude/settings.json',
                supportsHooks: true,
                configFormat: 'jsonc',
                configRootKey: 'mcpServers',
            };
        case 'codex':
            return {
                client,
                configPath: '.codex/config.toml',
                guidancePath: home ? '.codex/AGENTS.md' : 'AGENTS.md',
                hookPath: '.codex/hooks.json',
                supportsHooks: true,
                configFormat: 'toml',
                configRootKey: 'mcpServers',
            };
        case 'vscode':
            return {
                client,
                // User-scope resolution maps this logical path to the platform's
                // default VS Code user-profile directory.
                configPath: '.vscode/mcp.json',
                guidancePath: home
                    ? '.copilot/instructions/brainmcp.instructions.md'
                    : 'AGENTS.md',
                hookPath: home ? '.copilot/hooks/brainmcp.json' : '.github/hooks/brainmcp.json',
                supportsHooks: true,
                configFormat: 'jsonc',
                configRootKey: 'servers',
            };
        case 'copilot':
            return {
                client,
                // Copilot CLI's user configuration has its own schema and location.
                // Project scope intentionally uses the portable `.mcp.json` shape that
                // Claude Code and Copilot CLI can share without duplicate servers.
                configPath: home ? '.copilot/mcp-config.json' : '.mcp.json',
                guidancePath: home
                    ? '.copilot/instructions/brainmcp.instructions.md'
                    : '.github/copilot-instructions.md',
                supportsHooks: false,
                configFormat: 'jsonc',
                configRootKey: 'mcpServers',
            };
        case 'antigravity':
            return {
                client,
                configPath: home ? '.gemini/config/mcp_config.json' : '.agents/mcp_config.json',
                guidancePath: home ? '.gemini/GEMINI.md' : '.agents/rules/brainmcp.md',
                supportsHooks: false,
                configFormat: 'jsonc',
                configRootKey: 'mcpServers',
            };
        case 'generic':
            return {
                client,
                configPath: '.mcp.json',
                guidancePath: 'AGENTS.md',
                supportsHooks: false,
                configFormat: 'jsonc',
                configRootKey: 'mcpServers',
            };
    }
}
export function clientLabel(client) {
    return MCP_CLIENT_PROFILES[client].label;
}
export const WORKSPACE_UUID_REQUIRED = '--workspace must be the workspace UUID, not its slug or name (MCP tools and capture accept only the UUID).';
/**
 * The `--workspace` value shared by init, doctor, print, and capture. Init
 * writes it into agent guidance as the id MCP tools must pass, so a slug would
 * produce a binding agents cannot use.
 */
export function resolveWorkspace(value) {
    if (value === undefined)
        return undefined;
    const workspace = normalizeWorkspaceId(value);
    if (!isWorkspaceUuid(workspace))
        throw new Error(WORKSPACE_UUID_REQUIRED);
    return workspace;
}
export function guidancePreamble(client, scope) {
    if (client === 'cursor') {
        const rendered = renderCursorMdc();
        const frontmatter = rendered.match(/^---\n[\s\S]*?\n---\n*/)?.[0];
        if (!frontmatter)
            throw new Error('Cursor guidance renderer did not return frontmatter.');
        return frontmatter.trimEnd();
    }
    if ((client === 'vscode' || client === 'copilot') && scope === 'user') {
        return VSCODE_USER_INSTRUCTIONS_FRONTMATTER;
    }
    if (client === 'antigravity' && scope === 'project') {
        return ANTIGRAVITY_RULES_FRONTMATTER;
    }
    return undefined;
}
export function renderGuidance(client, workspaceId) {
    if (client === 'cursor') {
        const rendered = renderCursorMdc({ workspaceId });
        const frontmatter = rendered.match(/^---\n[\s\S]*?\n---\n*/)?.[0];
        if (!frontmatter)
            throw new Error('Cursor guidance renderer did not return frontmatter.');
        return `${MARKER_START}\n${rendered.slice(frontmatter.length).trim()}\n${MARKER_END}\n`;
    }
    return `${MARKER_START}\n${buildProjectInstructionBlock({ workspaceId })}\n${MARKER_END}\n`;
}
/** Pre-static-OAuth Antigravity installer shape. `init` upgrades it; `remove` still owns it. */
export const LEGACY_ANTIGRAVITY_SERVER_CONFIG = { serverUrl: BRAIN_MCP_ENDPOINT };
export function describeAntigravityServerConfig(server) {
    if (server?.serverUrl !== BRAIN_MCP_ENDPOINT || server.url !== undefined) {
        return { ok: false, detail: 'Antigravity requires serverUrl (legacy url is not supported)' };
    }
    if (server.oauth?.clientId !== MCP_OAUTH_CLIENT_IDS.antigravity) {
        return {
            ok: false,
            detail: `Antigravity requires oauth.clientId "${MCP_OAUTH_CLIENT_IDS.antigravity}"`,
        };
    }
    return { ok: true, detail: server.serverUrl };
}
export function brainServerConfig(client, scope = 'project') {
    switch (client) {
        case 'antigravity':
            return {
                serverUrl: BRAIN_MCP_ENDPOINT,
                oauth: {
                    clientId: MCP_OAUTH_CLIENT_IDS.antigravity,
                },
            };
        case 'cursor':
        case 'generic':
            // Cursor's documented static-client shape; also the shape we document for
            // generic clients that support a pre-registered CLIENT_ID.
            return {
                url: BRAIN_MCP_ENDPOINT,
                auth: { CLIENT_ID: MCP_CLIENT_PROFILES[client].oauthClientId },
            };
        case 'copilot':
            return scope === 'user'
                ? {
                    type: 'http',
                    url: BRAIN_MCP_ENDPOINT,
                    tools: ['*'],
                }
                : {
                    type: 'http',
                    url: BRAIN_MCP_ENDPOINT,
                };
        case 'claude-code':
        case 'vscode':
        case 'codex':
            // URL-only: these clients complete OAuth via DCR with their own exact
            // loopback callback; a static client id cannot match their random ports.
            return { type: 'http', url: BRAIN_MCP_ENDPOINT };
    }
}
export function renderTomlServer(client) {
    // Codex is the only TOML client today; keep markers around the canonical block.
    // `client` stays in the signature for the next TOML host.
    void client;
    const body = buildCodexConfigToml().trimEnd();
    return `${TOML_MARKER_START}\n${body}\n${TOML_MARKER_END}\n`;
}
//# sourceMappingURL=config.js.map