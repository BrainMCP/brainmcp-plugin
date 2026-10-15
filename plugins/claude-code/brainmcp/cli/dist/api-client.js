export class ApiClientError extends Error {
    status;
    statusText;
    body;
    response;
    constructor(response, body) {
        super(`brain API request failed: ${response.status} ${response.statusText}`);
        this.name = 'ApiClientError';
        this.status = response.status;
        this.statusText = response.statusText;
        this.body = body;
        this.response = response;
    }
    get isUnauthorized() {
        return this.status === 401;
    }
}
/**
 * The request never produced an HTTP response: `fetch` itself rejected (DNS,
 * refused/reset connection, service-binding failure). Thrown only from the
 * fetch call, so callers can tell a transport failure — safe to retry a read,
 * and the request may not have reached the API — from a later failure while
 * handling a response that did arrive. Cancellations (`AbortError`,
 * `TimeoutError`) are rethrown unchanged.
 *
 * It extends TypeError and keeps the original message, `code`, and `cause` so
 * callers that matched undici's `TypeError: fetch failed` keep working.
 */
export class ApiNetworkError extends TypeError {
    code;
    constructor(cause) {
        super(cause instanceof Error && cause.message ? cause.message : 'fetch failed', { cause });
        this.name = 'ApiNetworkError';
        const code = errorCode(cause) ?? errorCode(cause instanceof Error ? cause.cause : undefined);
        if (code)
            this.code = code;
    }
}
function errorCode(value) {
    const code = value && typeof value === 'object' ? value.code : undefined;
    return typeof code === 'string' ? code : undefined;
}
function isAbortLikeError(error) {
    const name = error && typeof error === 'object' ? error.name : undefined;
    return name === 'AbortError' || name === 'TimeoutError';
}
export class BrainMcpApiClient {
    baseUrl;
    fetchImpl;
    auth;
    defaultHeaders;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.fetchImpl = options.fetch ?? fetch;
        this.auth = options.auth;
        this.defaultHeaders = options.headers;
    }
    url(path, searchParams) {
        return buildApiUrl(this.baseUrl, path, searchParams);
    }
    request(path, options = {}) {
        const headers = mergeHeaders(this.defaultHeaders, options.headers);
        return apiFetch(this.url(path, options.searchParams), {
            ...options,
            auth: options.auth ?? this.auth,
            fetch: this.fetchImpl,
            headers,
        });
    }
    async json(path, options = {}) {
        const response = await this.request(path, options);
        return response.json();
    }
    createContextPath(workspaceId, body) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths`, { json: body, method: 'POST' });
    }
    listContextPaths(workspaceId, searchParams) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths`, { searchParams });
    }
    getContextPath(workspaceId, pathId, searchParams) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths/${apiPathSegment(pathId)}`, { searchParams });
    }
    getContextPathStep(workspaceId, pathId, stepId) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths/${apiPathSegment(pathId)}/steps/${apiPathSegment(stepId)}`);
    }
    deleteContextPath(workspaceId, pathId) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths/${apiPathSegment(pathId)}`, { method: 'DELETE' });
    }
    updateContextPathVisibility(workspaceId, pathId, body) {
        return this.json(`/api/workspaces/${apiPathSegment(workspaceId)}/context-paths/${apiPathSegment(pathId)}/visibility`, { json: body, method: 'PATCH' });
    }
}
export function createApiClient(options) {
    return new BrainMcpApiClient(options);
}
/**
 * Encode a single path segment (workspace/node/proposal id, …) for safe
 * interpolation into an API path. Use this at every `${value}` site rather than
 * relying on the value looking like an id.
 */
export function apiPathSegment(value) {
    const encoded = encodeURIComponent(value);
    // `encodeURIComponent` leaves `.` alone, so an all-dots value would still be
    // a `.` / `..` path segment. The WHATWG URL parser also collapses `%2E` /
    // `%2E%2E`, so percent-encoding alone does not neutralize them:
    // `buildApiUrl` rejects every single- or double-dot segment, encoded or not.
    return /^\.+$/.test(encoded) ? encoded.replaceAll('.', '%2E') : encoded;
}
/**
 * Build an API URL. The base origin is pinned as a string prefix — never via
 * the two-argument `new URL(path, base)` resolver, which treats a `//host/…`
 * path as scheme-relative and would forward the caller's bearer token to an
 * attacker host. Paths must be clean absolute paths so a prompt-injected id
 * containing `..` cannot retarget the request at a different endpoint than the
 * caller intended.
 */
export function buildApiUrl(baseUrl, path, searchParams) {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const pathOnly = cleanPath.split('?')[0] ?? cleanPath;
    if (pathOnly.startsWith('/') ||
        pathOnly.includes('\\') ||
        pathOnly.includes('//') ||
        // The URL parser treats `%2e` and `%2e%2e` (any case, any mix) exactly
        // like `.` and `..`, so reject the encoded forms too.
        pathOnly.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
        throw new Error(`Unsafe API request path: ${path}`);
    }
    const url = new URL(`${normalizedBase}/${cleanPath}`);
    if (url.origin !== new URL(`${normalizedBase}/`).origin) {
        throw new Error(`Unsafe API request path: ${path}`);
    }
    if (searchParams instanceof URLSearchParams) {
        searchParams.forEach((value, key) => url.searchParams.append(key, value));
    }
    else if (searchParams) {
        for (const [key, value] of Object.entries(searchParams)) {
            if (value !== null && value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url;
}
export async function apiFetch(input, options = {}) {
    const headers = new Headers(options.headers);
    applyAuthHeaders(headers, options.auth);
    let body = options.body;
    if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
    }
    else if (body !== undefined && body !== null && !isBodyInit(body)) {
        body = JSON.stringify(body);
        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json');
        }
    }
    const fetchImpl = options.fetch ?? fetch;
    let response;
    try {
        response = await fetchImpl(input, {
            ...options,
            body,
            headers,
        });
    }
    catch (error) {
        if (isAbortLikeError(error) || options.signal?.aborted)
            throw error;
        throw new ApiNetworkError(error);
    }
    if (!response.ok) {
        throw new ApiClientError(response, await response.clone().text());
    }
    return response;
}
export function applyAuthHeaders(headers, auth) {
    if (!auth)
        return headers;
    if (auth.type === 'bearer') {
        headers.set('authorization', `Bearer ${auth.token}`);
    }
    else if (auth.type === 'cookie') {
        headers.set('cookie', auth.cookie);
    }
    else {
        new Headers(auth.headers).forEach((value, key) => headers.set(key, value));
    }
    return headers;
}
function mergeHeaders(...parts) {
    const merged = new Headers();
    for (const part of parts) {
        if (!part)
            continue;
        new Headers(part).forEach((value, key) => merged.set(key, value));
    }
    return merged;
}
function normalizeBaseUrl(baseUrl) {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
        throw new Error('API base URL is required.');
    }
    return trimmed.replace(/\/+$/, '');
}
function isBodyInit(value) {
    return (typeof value === 'string' ||
        value instanceof Blob ||
        value instanceof ArrayBuffer ||
        // Typed arrays and DataView (e.g. a Uint8Array upload) are raw bytes too.
        ArrayBuffer.isView(value) ||
        value instanceof FormData ||
        value instanceof URLSearchParams ||
        value instanceof ReadableStream);
}
