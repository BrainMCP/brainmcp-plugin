import { BRAINMCP_CLI_CLIENT_ID, BRAINMCP_CLI_ALLOWED_SCOPES, BRAINMCP_CLI_DEFAULT_SCOPES, BRAIN_MCP_ENDPOINT, BRAIN_MCP_ORIGIN, } from '../agent-config.js';
import { resolveCompanionOAuthIssuer } from './endpoints.js';
import { validateHttpUrl, withRequestDeadline } from './http.js';
export function grantedCliScopes(requested, tokenScope) {
    const allowed = new Set(BRAINMCP_CLI_ALLOWED_SCOPES);
    const raw = tokenScope === undefined ? requested : tokenScope.split(/\s+/).filter(Boolean);
    if (raw.some((scope) => !allowed.has(scope) || !requested.includes(scope))) {
        throw new Error('The OAuth server granted unrequested or disallowed CLI scopes.');
    }
    const granted = [...new Set(raw)];
    if (requested.some((scope) => !granted.includes(scope))) {
        throw new Error('The OAuth server did not grant required CLI scopes.');
    }
    return granted;
}
function validateTokenResponse(value) {
    const token = value;
    if (!token || typeof token.access_token !== 'string' || !token.access_token.trim() ||
        typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
        (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token.trim())) ||
        (token.scope !== undefined && typeof token.scope !== 'string') ||
        (token.expires_in !== undefined && (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0))) {
        throw new Error('OAuth server returned an invalid token response.');
    }
    return token;
}
/**
 * RFC 6749 §5.2 errors that mean this grant can never be refreshed again:
 * the refresh token is invalid, expired, or revoked, or the client binding is
 * gone. Retrying the same request cannot succeed; only a new login can.
 */
const DEFINITIVE_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);
export class OAuthGrantRejectedError extends Error {
    status;
    oauthError;
    constructor(status, oauthError) {
        super(`Token refresh rejected (status ${status}, ${oauthError}).`);
        this.name = 'OAuthGrantRejectedError';
        this.status = status;
        this.oauthError = oauthError;
    }
}
/**
 * The token endpoint answered a refresh with an HTTP error that does not prove
 * the grant dead: a 5xx, a 429, an edge error page, or a 400/401 without a
 * definitive OAuth error. The status is `refreshStatus`, not `status`, because
 * callers read `status` as the API's own answer, where 401 means "sign in
 * again". Without a class, hooks logged the 2026-10-11 token-endpoint outage
 * as `network`.
 */
export class OAuthRefreshFailedError extends Error {
    refreshStatus;
    constructor(status) {
        super(`Token refresh failed (status ${status}).`);
        this.name = 'OAuthRefreshFailedError';
        this.refreshStatus = status;
    }
}
/** Read only the standard `error` code; never surface the rest of the body. */
async function readOAuthErrorCode(res) {
    try {
        const body = (await res.json());
        const code = body?.error;
        return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null;
    }
    catch {
        return null;
    }
}
export const DEFAULT_ISSUER = BRAIN_MCP_ORIGIN;
/** Per-request limit when the caller sets none; it also bounds a refresh that outlives a hook deadline. */
export const DEFAULT_OAUTH_TIMEOUT_MS = 10_000;
export class OAuthClient {
    issuer;
    clientId;
    fetchFn;
    timeoutMs;
    constructor(options = {}) {
        this.issuer = (options.issuerUrl ?? resolveCompanionOAuthIssuer()).replace(/\/+$/, '');
        this.clientId = options.clientId ?? BRAINMCP_CLI_CLIENT_ID;
        this.fetchFn = options.fetchFn ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
        validateHttpUrl(this.issuer);
    }
    async discoverEndpoints(signal) {
        const discoveryUrl = `${this.issuer}/.well-known/oauth-authorization-server`;
        return withRequestDeadline(this.timeoutMs, signal, async (requestSignal) => {
            const res = await this.fetchFn(discoveryUrl, { signal: requestSignal, redirect: 'error' });
            if (res.ok) {
                const meta = (await res.json());
                if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
                    const endpoints = {
                        issuer: meta.issuer ?? this.issuer,
                        authorizationEndpoint: meta.authorization_endpoint ?? `${this.issuer}/api/auth/oauth2/authorize`,
                        tokenEndpoint: meta.token_endpoint ?? `${this.issuer}/api/auth/oauth2/token`,
                        revocationEndpoint: meta.revocation_endpoint ?? `${this.issuer}/api/auth/oauth2/revoke`,
                    };
                    for (const endpoint of Object.values(endpoints))
                        validateHttpUrl(endpoint, this.issuer);
                    return endpoints;
                }
                throw new Error('OAuth server returned invalid discovery metadata.');
            }
            if (res.status !== 404)
                throw new Error(`OAuth discovery failed (status ${res.status}).`);
            return {
                issuer: this.issuer,
                authorizationEndpoint: `${this.issuer}/api/auth/oauth2/authorize`,
                tokenEndpoint: `${this.issuer}/api/auth/oauth2/token`,
                revocationEndpoint: `${this.issuer}/api/auth/oauth2/revoke`,
            };
        });
    }
    buildAuthorizationUrl(input) {
        const scopes = input.scopes ?? [...BRAINMCP_CLI_DEFAULT_SCOPES];
        const url = validateHttpUrl(input.authorizationEndpoint, this.issuer);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.clientId);
        url.searchParams.set('redirect_uri', input.redirectUri);
        url.searchParams.set('scope', scopes.join(' '));
        url.searchParams.set('state', input.pkce.state);
        url.searchParams.set('code_challenge', input.pkce.challenge);
        url.searchParams.set('code_challenge_method', input.pkce.method);
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('resource', BRAIN_MCP_ENDPOINT);
        return url.toString();
    }
    async exchangeCodeForTokens(input) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
            resource: BRAIN_MCP_ENDPOINT,
        });
        validateHttpUrl(input.tokenEndpoint, this.issuer);
        return withRequestDeadline(this.timeoutMs, input.signal, async (signal) => {
            const res = await this.fetchFn(input.tokenEndpoint, {
                signal,
                redirect: 'error',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: body.toString(),
            });
            if (!res.ok) {
                throw new Error(`Token exchange failed (status ${res.status}).`);
            }
            return validateTokenResponse(await res.json());
        });
    }
    async refreshAccessToken(input) {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: input.refreshToken,
            resource: BRAIN_MCP_ENDPOINT,
        });
        validateHttpUrl(input.tokenEndpoint, this.issuer);
        return withRequestDeadline(this.timeoutMs, input.signal, async (signal) => {
            const res = await this.fetchFn(input.tokenEndpoint, {
                signal,
                redirect: 'error',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: body.toString(),
            });
            if (!res.ok) {
                if (res.status === 400 || res.status === 401) {
                    const code = await readOAuthErrorCode(res);
                    if (code && DEFINITIVE_GRANT_ERRORS.has(code))
                        throw new OAuthGrantRejectedError(res.status, code);
                }
                throw new OAuthRefreshFailedError(res.status);
            }
            return validateTokenResponse(await res.json());
        });
    }
    async revokeToken(input) {
        const body = new URLSearchParams({
            client_id: this.clientId,
            token: input.token,
        });
        validateHttpUrl(input.revocationEndpoint, this.issuer);
        return withRequestDeadline(this.timeoutMs, input.signal, async (signal) => {
            const res = await this.fetchFn(input.revocationEndpoint, {
                signal,
                redirect: 'error',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });
            return res.ok;
        });
    }
}
//# sourceMappingURL=oauth-client.js.map