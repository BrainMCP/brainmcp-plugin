import { BRAIN_API_ORIGIN, BRAIN_DASHBOARD_URL, BRAIN_MCP_ORIGIN } from '../agent-config.js';
/** The request deadline elapsed, or the caller cancelled, before the response completed. */
export class RequestDeadlineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RequestDeadlineError';
    }
}
/** Keep deadlines active through response-body consumption as well as headers. */
export async function withRequestDeadline(timeoutMs, signal, action) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    const timer = setTimeout(() => controller.abort(new RequestDeadlineError('Request timed out')), timeoutMs);
    let onAbort;
    try {
        controller.signal.throwIfAborted();
        const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(new RequestDeadlineError('Request cancelled or timed out'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        return await Promise.race([action(controller.signal), cancelled]);
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (onAbort)
            controller.signal.removeEventListener('abort', onAbort);
    }
}
const BRAIN_ORIGINS = new Set([
    BRAIN_MCP_ORIGIN,
    BRAIN_API_ORIGIN,
    new URL(BRAIN_DASHBOARD_URL).origin,
]);
export function validateHttpUrl(value, trustedBase) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('Invalid API or OAuth endpoint URL.');
    }
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.hash) {
        throw new Error('API and OAuth endpoints require HTTPS (HTTP is allowed only on loopback), without credentials or fragments.');
    }
    if (trustedBase) {
        const origin = new URL(trustedBase).origin;
        if (url.origin !== origin && !(BRAIN_ORIGINS.has(origin) && BRAIN_ORIGINS.has(url.origin))) {
            throw new Error('OAuth endpoint origin does not match the trusted Brain issuer.');
        }
    }
    return url;
}
//# sourceMappingURL=http.js.map