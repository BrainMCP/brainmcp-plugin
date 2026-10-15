import { createServer } from 'node:http';
import { URL } from 'node:url';
const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>BrainMCP Authentication Successful</title><style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
.card { background: #1e293b; padding: 2rem 3rem; border-radius: 12px; border: 1px solid #334155; text-align: center; max-width: 480px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #38bdf8; }
p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>Authentication Successful</h1><p>You may close this tab and return to your terminal.</p></div></body>
</html>`;
const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html>
<head><title>BrainMCP Authentication Failed</title><style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
.card { background: #1e293b; padding: 2rem 3rem; border-radius: 12px; border: 1px solid #dc2626; text-align: center; max-width: 480px; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f87171; }
p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>Authentication Failed</h1><p>${escapeHtml(msg)}</p></div></body>
</html>`;
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
export async function startCallbackServer(options) {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const expectedPathname = options.pathname ?? '/callback';
    let hasFinished = false;
    let isConsumed = false;
    let server = null;
    let timeoutHandle = null;
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // Prevent unhandledRejection if close() is invoked before consumer calls waitForCallback()
    resultPromise.catch(() => { });
    const closeServer = async () => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        if (server) {
            const s = server;
            server = null;
            const closed = new Promise((resolve) => s.close(() => resolve()));
            // close() alone waits for every open socket, and browsers keep
            // speculative preconnects open without sending a request, which left
            // `brainmcp login` running after success. The response has already been
            // sent, so drop whatever connections remain.
            s.closeAllConnections();
            await closed;
        }
    };
    server = createServer((req, res) => {
        if (!req.url) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
            return;
        }
        const hostHeader = req.headers.host;
        // Strict host check: must be 127.0.0.1 or localhost with optional port
        if (!hostHeader || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHeader)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid host header');
            return;
        }
        const parsedUrl = new URL(req.url, `http://${hostHeader}`);
        // Path verification
        if (parsedUrl.pathname !== expectedPathname) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        // One-shot check
        if (isConsumed) {
            res.writeHead(409, { 'Content-Type': 'text/html' });
            res.end(ERROR_HTML('Callback already consumed or timed out.'));
            return;
        }
        // State verification
        const state = parsedUrl.searchParams.get('state');
        if (!state || state !== options.expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(ERROR_HTML('State parameter mismatch or missing.'));
            return;
        }
        // Mark as consumed
        isConsumed = true;
        hasFinished = true;
        const error = parsedUrl.searchParams.get('error');
        const errorDescription = parsedUrl.searchParams.get('error_description') ?? undefined;
        const code = parsedUrl.searchParams.get('code') ?? undefined;
        if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(ERROR_HTML(errorDescription || `Error: ${error}`));
            resolveResult({ error, errorDescription });
            setTimeout(() => void closeServer(), 500);
            return;
        }
        if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(ERROR_HTML('Missing authorization code in callback.'));
            resolveResult({ error: 'missing_code', errorDescription: 'Authorization code was not provided.' });
            setTimeout(() => void closeServer(), 500);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveResult({ code });
        setTimeout(() => void closeServer(), 500);
    });
    // Bind exclusively to 127.0.0.1 port 0
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
    });
    const address = server.address();
    const port = address.port;
    const redirectUri = `http://127.0.0.1:${port}${expectedPathname}`;
    timeoutHandle = setTimeout(() => {
        if (!hasFinished) {
            hasFinished = true;
            isConsumed = true;
            rejectResult(new Error(`Authentication timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
            void closeServer();
        }
    }, timeoutMs);
    return {
        port,
        redirectUri,
        waitForCallback: () => resultPromise,
        close: async () => {
            if (!hasFinished) {
                hasFinished = true;
                isConsumed = true;
                rejectResult(new Error('Authentication cancelled by user.'));
            }
            await closeServer();
        },
    };
}
//# sourceMappingURL=callback-server.js.map