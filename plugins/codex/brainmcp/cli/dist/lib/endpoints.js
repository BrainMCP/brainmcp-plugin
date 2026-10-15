import { BRAIN_API_ORIGIN, BRAIN_MCP_ORIGIN } from '../agent-config.js';
import { validateHttpUrl } from './http.js';
export const COMPANION_WORKSPACES_PATH = '/api/mcp/workspaces';
const MCP_REST_HOSTS = new Set(['mcp.brainmcp.ai', 'dash.brainmcp.ai']);
function absoluteHttpUrl(value) {
    const url = validateHttpUrl(value.replace(/\/+$/, ''));
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
}
export function resolveCompanionApiUrl(env = process.env) {
    return absoluteHttpUrl(env.BRAINMCP_API_URL?.trim() || BRAIN_API_ORIGIN);
}
export function resolveCompanionOAuthIssuer(env = process.env) {
    return absoluteHttpUrl(env.BRAINMCP_OAUTH_ISSUER?.trim() || BRAIN_MCP_ORIGIN);
}
export function describeMisdirectedCompanionApi(apiUrl) {
    let hostname;
    try {
        hostname = new URL(apiUrl).hostname;
    }
    catch {
        return null;
    }
    if (!MCP_REST_HOSTS.has(hostname))
        return null;
    return `Companion REST must use ${BRAIN_API_ORIGIN}, not ${apiUrl}. Unset BRAINMCP_API_URL or point it at the API origin.`;
}
export function companionWorkspacesUrl(apiUrl = resolveCompanionApiUrl()) {
    return new URL(COMPANION_WORKSPACES_PATH, `${absoluteHttpUrl(apiUrl)}/`).toString();
}
//# sourceMappingURL=endpoints.js.map