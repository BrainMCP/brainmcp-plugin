import { randomUUID } from 'node:crypto';
import { BRAIN_API_ORIGIN, BRAIN_OAUTH_ISSUER } from '../agent-config.js';
import { describeMisdirectedCompanionApi, resolveCompanionApiUrl } from './endpoints.js';
import { grantedCliScopes, OAuthClient, OAuthGrantRejectedError } from './oauth-client.js';
import { validateHttpUrl, withRequestDeadline } from './http.js';
/**
 * The companion grant is dead (its refresh token was rejected) and only a new
 * `brainmcp login` can restore it. `status` is 401 so existing auth-failure
 * classifiers (capture retry, orientation) treat it as an auth problem.
 */
export class CompanionReauthRequiredError extends Error {
    status = 401;
    code = 'reauth_required';
    constructor() {
        super('BrainMCP CLI sign-in expired or was revoked. Run `brainmcp login` to sign in again.');
        this.name = 'CompanionReauthRequiredError';
    }
}
/** Refresh this long before the recorded expiry so clock skew cannot send a dead token. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 30_000;
export function accessTokenExpiresSoon(creds) {
    const expiresAt = Date.parse(creds.expiresAt ?? '');
    return Number.isFinite(expiresAt) && expiresAt - Date.now() < ACCESS_TOKEN_REFRESH_MARGIN_MS;
}
/** Error bodies are small JSON objects; anything longer is not read further. */
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const API_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/**
 * The API's machine-readable error `code` (for example `pending_digest_cap_reached`),
 * or undefined. Only a short snake_case token is kept: the rest of the body can
 * echo captured content and never leaves this function.
 */
async function readApiErrorCode(res) {
    if (!res.body || !/\bjson\b/i.test(res.headers.get('content-type') ?? '')) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        while (bytes <= MAX_ERROR_BODY_BYTES) {
            const { done, value } = await reader.read();
            if (done)
                break;
            chunks.push(value);
            bytes += value.byteLength;
        }
        if (bytes > MAX_ERROR_BODY_BYTES)
            return undefined;
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const code = parsed && typeof parsed === 'object' ? parsed.code : undefined;
        return typeof code === 'string' && API_ERROR_CODE.test(code) ? code : undefined;
    }
    catch {
        // Malformed JSON or a failed read: the status alone classifies the failure.
        return undefined;
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
}
/** A stored token endpoint is used only while it still passes the issuer trust check. */
/**
 * The advertised token endpoint is the dashboard's, which only forwards the
 * request to the same path on the API (apps/dashboard/lib/api-proxy.ts).
 * Refreshes go to the API directly: that skips the dashboard Worker's start-up
 * and its second public request, and keeps refreshes working when the
 * dashboard is down (its 2026-10-11 outage failed every companion refresh).
 * Credentials keep the advertised endpoint; any other endpoint is used as is.
 */
const ADVERTISED_TOKEN_ENDPOINT = `${BRAIN_OAUTH_ISSUER}/oauth2/token`;
const DIRECT_TOKEN_ENDPOINT = `${BRAIN_API_ORIGIN}/api/auth/oauth2/token`;
export function refreshRequestEndpoint(tokenEndpoint) {
    return tokenEndpoint === ADVERTISED_TOKEN_ENDPOINT ? DIRECT_TOKEN_ENDPOINT : tokenEndpoint;
}
function trustedTokenEndpoint(endpoint, issuer) {
    if (!endpoint)
        return undefined;
    try {
        return validateHttpUrl(endpoint, issuer).toString();
    }
    catch {
        return undefined;
    }
}
export class ApiClient {
    apiUrl;
    store;
    oauthClient;
    fetchFn;
    serviceToken;
    defaultTimeoutMs;
    constructor(options) {
        this.apiUrl = (options.apiUrl ?? resolveCompanionApiUrl()).replace(/\/+$/, '');
        this.store = options.store;
        this.fetchFn = options.fetchFn ?? fetch;
        this.oauthClient = options.oauthClient ?? new OAuthClient({ fetchFn: this.fetchFn });
        this.serviceToken = options.serviceToken ?? process.env.BRAINMCP_SERVICE_TOKEN;
        this.defaultTimeoutMs = options.timeoutMs ?? 15_000;
        validateHttpUrl(this.apiUrl);
    }
    async getEffectiveCredentials() {
        const stored = await this.store.get();
        if (stored?.authType === 'oauth' && stored.accessToken) {
            return stored;
        }
        if (this.serviceToken) {
            return {
                version: 1,
                authType: 'service',
                serviceToken: this.serviceToken,
                updatedAt: new Date().toISOString(),
            };
        }
        return stored;
    }
    async request(path, options = {}) {
        return withRequestDeadline(options.timeoutMs ?? this.defaultTimeoutMs, options.signal, async (signal) => {
            const explicitAuthorization = new Headers(options.headers).has('Authorization');
            const useStoredAuth = !options.skipAuth && !explicitAuthorization;
            const creds = useStoredAuth ? await this.getEffectiveCredentials() : null;
            signal.throwIfAborted();
            if (options.expectedAuthorizationId && creds?.authorizationId !== options.expectedAuthorizationId) {
                throw new Error('Companion authorization changed before the request.');
            }
            if (creds?.authType === 'oauth' && creds.reauthRequired) {
                throw new CompanionReauthRequiredError();
            }
            const url = new URL(path, `${this.apiUrl}/`);
            if (url.origin !== new URL(this.apiUrl).origin || url.username || url.password) {
                throw new Error('API requests must use the configured API origin.');
            }
            const isOrientEndpoint = url.pathname.endsWith('/orient');
            if (creds?.authType === 'service' && isOrientEndpoint) {
                throw new Error('Service tokens cannot access /orient. Interactive companion OAuth credentials are required for session orientation.');
            }
            const requestId = randomUUID();
            const execute = async (token) => {
                const headers = new Headers(options.headers);
                headers.set('x-request-id', requestId);
                headers.set('Accept', 'application/json');
                if (options.body && !headers.has('Content-Type')) {
                    headers.set('Content-Type', 'application/json');
                }
                if (token && useStoredAuth) {
                    headers.set('Authorization', `Bearer ${token}`);
                }
                signal.throwIfAborted();
                if (options.beforeSend && !options.beforeSend())
                    throw new Error('Request cancelled because capture consent changed.');
                return await this.fetchFn(url.toString(), {
                    method: options.method ?? (options.body ? 'POST' : 'GET'),
                    headers,
                    body: options.body ? JSON.stringify(options.body) : undefined,
                    signal,
                    redirect: 'error',
                });
            };
            let token = creds?.authType === 'oauth' ? creds.accessToken ?? null : creds?.serviceToken ?? null;
            let refreshed = false;
            // A short-lived hook process usually starts with an expired access token
            // (they last about an hour). Refresh first instead of spending a round trip
            // on a request the server will reject with 401.
            if (creds?.authType === 'oauth' && creds.refreshToken && accessTokenExpiresSoon(creds)) {
                refreshed = true;
                const renewed = await this.refreshTokensWithLock(token, creds, signal);
                if (renewed)
                    token = renewed.accessToken ?? null;
            }
            let res = await execute(token);
            // Handle 401 with refresh-once policy if using OAuth credentials
            if (res.status === 401 && creds?.authType === 'oauth' && creds.refreshToken && !refreshed) {
                await res.body?.cancel();
                const refreshed = await this.refreshTokensWithLock(token, creds, signal);
                if (refreshed) {
                    token = refreshed.accessToken ?? null;
                    res = await execute(token);
                }
            }
            if (!res.ok) {
                // Response bodies can echo credentials or captured content. Keep them out
                // of terminal output, persisted queue errors, and hook diagnostics.
                const misdirected = res.status === 404 ? describeMisdirectedCompanionApi(this.apiUrl) : null;
                const code = await readApiErrorCode(res);
                const error = new Error(misdirected
                    ? `API request failed (status 404) for ${url.pathname}. ${misdirected}`
                    : `API request failed (status ${res.status})`);
                error.status = res.status;
                if (code)
                    error.code = code;
                throw error;
            }
            if (res.status === 204) {
                return undefined;
            }
            return (await res.json());
        });
    }
    /**
     * Runs the refresh `request` would do before sending, on its own: when the
     * stored access token expires within the refresh margin, refresh it now.
     * Resolves false when no refresh was needed. Failures match `request`: a
     * rejected grant throws CompanionReauthRequiredError, and a sent refresh
     * still persists after this call's deadline.
     */
    async refreshAccessTokenIfExpiring(options = {}) {
        return withRequestDeadline(options.timeoutMs ?? this.defaultTimeoutMs, options.signal, async (signal) => {
            const creds = await this.getEffectiveCredentials();
            signal.throwIfAborted();
            if (creds?.authType !== 'oauth' || !creds.refreshToken)
                return false;
            if (creds.reauthRequired)
                throw new CompanionReauthRequiredError();
            if (!accessTokenExpiresSoon(creds))
                return false;
            await this.refreshTokensWithLock(creds.accessToken ?? null, creds, signal);
            return true;
        });
    }
    async refreshTokensWithLock(failedAccessToken, original, signal) {
        const leaseHolder = randomUUID();
        const leaseDurationMs = 15_000;
        let refreshToken = null;
        let cachedTokenEndpoint;
        // Claim a short fenced lease under the credential lock, then release the
        // filesystem lock before doing OAuth network I/O. A concurrent process
        // either reuses the rotated credential or waits for the lease owner: until
        // the owner stores its rotation, or until the lease expires and can be taken
        // over, bounded by the caller's deadline. Giving up earlier (after about 5 s
        // of a 15 s lease) sent the expired token, and its 401 failed a queued
        // capture as signed out although the grant was fine.
        for (;;) {
            signal.throwIfAborted();
            const claim = await this.store.withRefreshLock(async (current) => {
                signal.throwIfAborted();
                if (current?.authorizationId !== original.authorizationId || current?.userId !== original.userId) {
                    return { kind: 'missing', current: null };
                }
                if (!current || current.authType !== 'oauth' || !current.refreshToken) {
                    return { kind: 'missing', current };
                }
                if (current.accessToken && current.accessToken !== failedAccessToken) {
                    return { kind: 'reuse', current };
                }
                const leaseExpiry = current.refreshLease
                    ? Date.parse(current.refreshLease.expiresAt)
                    : Number.NaN;
                // A lease that ends later than any holder sets one is corrupt: take it over.
                if (current.refreshLease &&
                    current.refreshLease.leaseHolder !== leaseHolder &&
                    Number.isFinite(leaseExpiry) &&
                    leaseExpiry > Date.now() &&
                    leaseExpiry <= Date.now() + leaseDurationMs + 5_000) {
                    return { kind: 'wait', current };
                }
                const updated = {
                    ...current,
                    refreshLease: {
                        leaseHolder,
                        expiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
                        revision: (current.refreshLease?.revision ?? 0) + 1,
                    },
                    updatedAt: new Date().toISOString(),
                };
                await this.store.set(updated);
                return { kind: 'claimed', current: updated };
            });
            if (claim.kind === 'missing')
                return claim.current;
            if (claim.kind === 'reuse')
                return claim.current;
            if (claim.kind === 'claimed') {
                refreshToken = claim.current.refreshToken ?? null;
                cachedTokenEndpoint = claim.current.tokenEndpoint;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 80 + Math.floor(Math.random() * 40)));
        }
        if (!refreshToken)
            return null;
        try {
            // Discovery has no side effects, so it stays under the caller's deadline.
            const tokenEndpoint = trustedTokenEndpoint(cachedTokenEndpoint, this.oauthClient.issuer)
                ?? (await this.oauthClient.discoverEndpoints(signal)).tokenEndpoint;
            signal.throwIfAborted();
            // Once the refresh token is on the wire the server may rotate it, which
            // invalidates the stored one. The caller's deadline must not abandon that
            // response or the persist below: dropping it strands the only valid
            // refresh token and kills the grant. The OAuth client's own timeout still
            // bounds the exchange; a timed-out caller just stops waiting for it.
            const tokenResponse = await this.oauthClient.refreshAccessToken({
                tokenEndpoint: refreshRequestEndpoint(tokenEndpoint),
                refreshToken,
            });
            return await this.store.withRefreshLock(async (current) => {
                if (!current || current.authType !== 'oauth' || current.authorizationId !== original.authorizationId || current.userId !== original.userId)
                    return null;
                // Discovery plus the exchange can outlast the lease, and another process
                // may have taken it over. While the stored refresh token is still the one
                // this refresh spent, the server rotated it here and this response holds
                // the only valid one, so it is persisted rather than dropped.
                if (current.refreshLease?.leaseHolder !== leaseHolder && current.refreshToken !== refreshToken) {
                    return current.accessToken !== failedAccessToken ? current : null;
                }
                if (current.refreshToken && current.refreshToken !== refreshToken) {
                    const reused = { ...current, refreshLease: undefined, updatedAt: new Date().toISOString() };
                    await this.store.set(reused);
                    return reused;
                }
                const now = new Date();
                const scopes = tokenResponse.scope === undefined
                    ? current.scopes
                    : grantedCliScopes(current.scopes ?? [], tokenResponse.scope);
                const updated = {
                    ...current,
                    accessToken: tokenResponse.access_token,
                    refreshToken: tokenResponse.refresh_token ?? current.refreshToken,
                    scopes,
                    expiresAt: tokenResponse.expires_in
                        ? new Date(now.getTime() + tokenResponse.expires_in * 1000).toISOString()
                        : current.expiresAt,
                    tokenEndpoint,
                    refreshLease: undefined,
                    // A process that took the lease over and was refused the spent token
                    // may have marked the grant dead; these tokens are its rotation.
                    reauthRequired: undefined,
                    updatedAt: now.toISOString(),
                };
                await this.store.set(updated);
                return updated;
            });
        }
        catch (error) {
            const rejection = error instanceof OAuthGrantRejectedError ? error : null;
            await this.store.withRefreshLock(async (current) => {
                if (current?.authType === 'oauth' && current.refreshLease?.leaseHolder === leaseHolder) {
                    await this.store.set({
                        ...current,
                        refreshLease: undefined,
                        // Mark the grant dead only if no other process rotated it meanwhile.
                        ...(rejection && current.refreshToken === refreshToken
                            ? { reauthRequired: { reason: 'refresh_rejected', oauthError: rejection.oauthError, detectedAt: new Date().toISOString() } }
                            : {}),
                        // Anything but a rejected grant may mean the endpoint moved: rediscover next time.
                        ...(rejection ? {} : { tokenEndpoint: undefined }),
                        updatedAt: new Date().toISOString(),
                    });
                }
            });
            throw rejection ? new CompanionReauthRequiredError() : error;
        }
    }
}
//# sourceMappingURL=api-client.js.map