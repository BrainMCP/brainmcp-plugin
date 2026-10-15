import { spawn } from 'node:child_process';
import path from 'node:path';
import { stdin } from 'node:process';
import { BRAINMCP_CLI_CLIENT_ID, BRAINMCP_CLI_DEFAULT_SCOPES, } from '../agent-config.js';
import { ApiClient } from '../lib/api-client.js';
import { COMPANION_WORKSPACES_PATH } from '../lib/endpoints.js';
import { startCallbackServer } from '../lib/callback-server.js';
import { isWorkspaceUuid, } from '../lib/cli-contracts.js';
import { createDefaultCredentialStore, MemoryCredentialStore } from '../lib/credentials.js';
import { grantedCliScopes, OAuthClient } from '../lib/oauth-client.js';
export { grantedCliScopes } from '../lib/oauth-client.js';
import { generatePkce } from '../lib/pkce.js';
import { enableCapture, disableCapture } from '../runtime/capture.js';
import { migrateLegacyFlatState, switchCurrentAccount, clearCurrentAccount, getBrainHome, getCurrentAccountId, readPreferences, resolveStateDir, sanitizeAccountId, SERVICE_ACCOUNT_ID, } from '../runtime/storage.js';
import { clearOrientCache } from '../runtime/orient.js';
import { withSessionLock } from '../runtime/lock.js';
const MAX_SERVICE_TOKEN_STDIN_BYTES = 64 * 1024;
/**
 * The workspace allowlist and default to store for a companion login. The
 * default must be one of the listed workspaces: capture and orientation go
 * there, so an ambiguous or unreachable default fails the login instead of
 * guessing.
 */
export function resolveCompanionWorkspaceGrant(listed) {
    const rows = Array.isArray(listed.workspaces) ? listed.workspaces : [];
    const ids = [...new Set(rows
            .map((workspace) => workspace?.id)
            .filter((id) => typeof id === 'string' && isWorkspaceUuid(id)))];
    if (ids.length === 0) {
        throw new Error('The OAuth server did not return an explicit companion workspace allowlist.');
    }
    const accountDefault = typeof listed.account?.defaultWorkspaceId === 'string'
        ? listed.account.defaultWorkspaceId.trim()
        : '';
    if (accountDefault) {
        if (!ids.includes(accountDefault)) {
            throw new Error('The default workspace of this CLI grant is not among the workspaces it can reach (it may be archived or require two-factor authentication). Run `brainmcp login` again (with `--force` if already signed in) and choose a reachable default workspace.');
        }
        return { workspaces: ids, defaultWorkspaceId: accountDefault };
    }
    // Compatibility with responses that marked the default on the workspace row.
    const marked = [...new Set(rows
            .filter((workspace) => workspace?.isDefault === true && typeof workspace.id === 'string' && ids.includes(workspace.id))
            .map((workspace) => workspace.id))];
    if (marked.length === 1)
        return { workspaces: ids, defaultWorkspaceId: marked[0] };
    if (ids.length === 1)
        return { workspaces: ids, defaultWorkspaceId: ids[0] };
    throw new Error('The OAuth server did not return a default workspace for this multi-workspace CLI grant. Run `brainmcp login` again (with `--force` if already signed in) and choose a default workspace in the browser.');
}
async function resolveStore(store, allowFileCredentials, baseDir) {
    if (store)
        return { store, backend: 'memory' };
    return createDefaultCredentialStore({
        baseDir,
        allowFileCredentials,
        persistFileAcknowledgement: allowFileCredentials,
    });
}
async function defaultOpenBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    return await new Promise((resolve) => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.unref();
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}
async function readStdinServiceToken() {
    const chunks = [];
    let total = 0;
    for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_SERVICE_TOKEN_STDIN_BYTES) {
            throw new Error(`Service token input exceeds ${MAX_SERVICE_TOKEN_STDIN_BYTES} bytes.`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/, 1)[0] ?? '';
}
export function resetCompanionLocalState(home) {
    clearOrientCache(home);
    disableCapture({ baseDir: home });
}
/** Commit local identity only after the remote exchange has finished. */
export async function commitCompanionCredentials(input) {
    const commit = async () => {
        const previous = await input.store.get();
        // A grant the server already rejected is not a session worth protecting.
        if (previous && !input.force && !previous.reauthRequired)
            throw new Error('Already authenticated. Pass --force to replace the stored credentials.');
        const previousAccount = input.home ? getCurrentAccountId(input.home) : null;
        const accountId = input.credentials.userId;
        // Unclaimed legacy state belongs to its known old identity, never to the
        // account selected by a replacement login. Unknown-owner state stays flat.
        if (input.home && !previousAccount && previous?.userId)
            migrateLegacyFlatState(input.home, previous.userId);
        const stateDir = input.home ? switchCurrentAccount(input.home, accountId) : null;
        try {
            await input.store.withRefreshLock(async () => { await input.store.set(input.credentials); });
            if (input.home)
                switchCurrentAccount(input.home, accountId);
            if (stateDir) {
                resetCompanionLocalState(stateDir);
                if (input.captureWorkspaceId)
                    enableCapture({ baseDir: stateDir, workspaceId: input.captureWorkspaceId });
            }
        }
        catch (error) {
            if (input.home && getCurrentAccountId(input.home) === sanitizeAccountId(accountId)) {
                if (previousAccount)
                    switchCurrentAccount(input.home, previousAccount);
                else
                    clearCurrentAccount(input.home);
            }
            throw error;
        }
    };
    if (input.home)
        await withSessionLock('account-switch', commit, { baseDir: path.join(input.home, 'shared') });
    else
        await commit();
}
function companionRuntimeHome(options) {
    const home = options.runtimeHome ?? process.env.BRAINMCP_HOME ?? process.env.BRAIN_HOME;
    if (home)
        return home;
    if (options.store)
        return null;
    return getBrainHome();
}
export async function login(options = {}) {
    const output = options.output ?? console.log;
    const errorOutput = options.errorOutput ?? console.error;
    if (options.storeServiceToken && !options.serviceTokenStdin) {
        throw new Error('--store-service-token is valid only with --service-token-stdin.');
    }
    const { store } = options.serviceTokenStdin && !options.storeServiceToken
        ? { store: options.store ?? new MemoryCredentialStore() }
        : await resolveStore(options.store, options.allowFileCredentials, options.runtimeHome);
    const oauthClient = options.oauthClient ?? new OAuthClient();
    if (options.serviceTokenStdin) {
        if (options.captureDigests) {
            throw new Error('Service-token login cannot be mixed with --capture-digests.');
        }
        const token = (await (options.readServiceToken ?? readStdinServiceToken)()).trim();
        if (!token) {
            throw new Error('No service token received on stdin.');
        }
        if (Buffer.byteLength(token, 'utf8') > MAX_SERVICE_TOKEN_STDIN_BYTES) {
            throw new Error(`Service token input exceeds ${MAX_SERVICE_TOKEN_STDIN_BYTES} bytes.`);
        }
        if (options.storeServiceToken) {
            await commitCompanionCredentials({ home: companionRuntimeHome(options), store, force: options.force, credentials: {
                    version: 1,
                    authType: 'service',
                    serviceToken: token,
                    userId: SERVICE_ACCOUNT_ID,
                    updatedAt: new Date().toISOString(),
                } });
        }
        else {
            process.env.BRAINMCP_SERVICE_TOKEN = token;
        }
        const envelope = {
            status: 'authenticated',
            authType: 'service',
            clientId: 'service-token',
            scopes: [],
        };
        if (options.json) {
            output(JSON.stringify(envelope, null, 2));
        }
        else {
            output(options.storeServiceToken
                ? '✓ Service token stored locally. This credential cannot call /orient or enable lifecycle capture.'
                : '✓ Service token accepted for this process only. It was not written to disk.');
        }
        return;
    }
    const existing = await store.get();
    if (existing && !options.force && !existing.reauthRequired) {
        throw new Error('Already authenticated. Pass --force to replace the stored companion credentials.');
    }
    const scopes = [...BRAINMCP_CLI_DEFAULT_SCOPES];
    if (options.captureDigests) {
        scopes.push('digests:write');
    }
    const pkce = generatePkce();
    const callbackServer = await startCallbackServer({
        expectedState: pkce.state,
        timeoutMs: 300_000,
    });
    try {
        const endpoints = await oauthClient.discoverEndpoints();
        const authUrl = oauthClient.buildAuthorizationUrl({
            authorizationEndpoint: endpoints.authorizationEndpoint,
            redirectUri: callbackServer.redirectUri,
            pkce,
            scopes,
        });
        const humanOutput = options.json ? errorOutput : output;
        if (options.captureDigests) {
            humanOutput('Digest capture will upload bounded host/model labels, Git metadata, relative edited paths, and stable assistant summaries to Brain. Prompts, transcripts, file contents, and tool payloads are excluded. Disable with `brainmcp capture disable`.');
        }
        humanOutput('Opening browser to authenticate with BrainMCP:');
        humanOutput(`  ${authUrl}`);
        humanOutput('If the browser did not open automatically, copy and paste the URL above into your browser.\n');
        const opener = options.openBrowser ?? defaultOpenBrowser;
        if (opener) {
            await opener(authUrl).catch(() => false);
        }
        const callbackResult = await callbackServer.waitForCallback();
        if (callbackResult.error) {
            throw new Error(`Authentication rejected by provider: ${callbackResult.errorDescription || callbackResult.error}`);
        }
        if (!callbackResult.code) {
            throw new Error('No authorization code received from callback.');
        }
        const tokenResponse = await oauthClient.exchangeCodeForTokens({
            tokenEndpoint: endpoints.tokenEndpoint,
            code: callbackResult.code,
            redirectUri: callbackServer.redirectUri,
            codeVerifier: pkce.verifier,
        });
        const now = new Date();
        const expiresAt = tokenResponse.expires_in
            ? new Date(now.getTime() + tokenResponse.expires_in * 1000).toISOString()
            : undefined;
        const grantedScopes = grantedCliScopes(scopes, typeof tokenResponse.scope === 'string' ? tokenResponse.scope : undefined);
        const credentialsRecord = {
            version: 1,
            authType: 'oauth',
            accessToken: tokenResponse.access_token,
            refreshToken: tokenResponse.refresh_token,
            expiresAt,
            clientId: oauthClient.clientId,
            scopes: grantedScopes,
            tokenEndpoint: endpoints.tokenEndpoint,
            updatedAt: now.toISOString(),
        };
        const home = companionRuntimeHome(options);
        const apiClient = options.apiClient ?? new ApiClient({ store, oauthClient });
        const listed = await apiClient.request(COMPANION_WORKSPACES_PATH, {
            timeoutMs: 3_000,
            headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        if (listed.account?.clientId !== BRAINMCP_CLI_CLIENT_ID) {
            throw new Error('The issued OAuth token is not bound to the BrainMCP CLI client.');
        }
        if (!listed.account?.authorizationId) {
            throw new Error('The OAuth server did not return the companion authorization identity.');
        }
        if (!listed.account?.userId?.trim()) {
            throw new Error('The OAuth server did not return the companion account identity.');
        }
        const grant = resolveCompanionWorkspaceGrant(listed);
        credentialsRecord.workspaces = grant.workspaces;
        credentialsRecord.defaultWorkspaceId = grant.defaultWorkspaceId;
        credentialsRecord.userId = listed.account.userId.trim();
        credentialsRecord.authorizationId = listed.account.authorizationId;
        credentialsRecord.provenance = listed.account.provenance;
        if (listed.account.scopes) {
            credentialsRecord.scopes = grantedCliScopes(scopes, listed.account.scopes.join(' '));
        }
        await commitCompanionCredentials({ home, store, credentials: credentialsRecord, force: options.force,
            captureWorkspaceId: options.captureDigests && credentialsRecord.scopes?.includes('digests:write')
                ? credentialsRecord.defaultWorkspaceId ?? undefined : undefined });
        const responseEnvelope = {
            status: 'authenticated',
            authType: 'oauth',
            clientId: oauthClient.clientId,
            scopes: credentialsRecord.scopes ?? grantedScopes,
            workspaces: credentialsRecord.workspaces ?? [],
            defaultWorkspaceId: credentialsRecord.defaultWorkspaceId ?? null,
            provenance: credentialsRecord.provenance,
        };
        if (options.json) {
            output(JSON.stringify(responseEnvelope, null, 2));
        }
        else {
            output(`✓ Successfully authenticated with BrainMCP!`);
            output(`  Client: ${oauthClient.clientId}`);
            output(`  Scopes: ${grantedScopes.join(', ')}`);
            output('  This companion grant is for CLI hooks and orientation only.');
            output('  Host agents still need their own MCP OAuth (for Cursor: Settings → Tools & MCP → brain).');
        }
    }
    finally {
        await callbackServer.close().catch(() => { });
    }
}
export async function logout(options = {}) {
    const output = options.output ?? console.log;
    const { store } = await resolveStore(options.store, true, options.runtimeHome);
    const oauthClient = options.oauthClient ?? new OAuthClient();
    const home = companionRuntimeHome(options);
    const accountId = home ? getCurrentAccountId(home) : null;
    const stateDir = home ? resolveStateDir(home) : null;
    const current = await store.get();
    if (!current) {
        const res = {
            status: 'logged_out',
            clearedCredentials: false,
        };
        if (options.json) {
            output(JSON.stringify(res, null, 2));
        }
        else {
            output('Not currently logged in.');
        }
        return;
    }
    let revokedOnServer = false;
    let warning;
    if (current.authType === 'oauth' && (current.refreshToken || current.accessToken)) {
        try {
            const endpoints = await oauthClient.discoverEndpoints();
            revokedOnServer = await oauthClient.revokeToken({
                revocationEndpoint: endpoints.revocationEndpoint,
                token: (current.refreshToken || current.accessToken),
            });
            if (!revokedOnServer) {
                warning = 'Server token revocation returned a non-200 response; local credentials cleared.';
            }
        }
        catch {
            warning = 'Network error during server token revocation; local credentials cleared.';
        }
    }
    const clearedCredentials = await store.withRefreshLock(async (latest) => {
        if (!latest || latest.userId !== current.userId || latest.authorizationId !== current.authorizationId || latest.authType !== current.authType)
            return false;
        await store.clear();
        if (stateDir)
            resetCompanionLocalState(stateDir);
        if (home && getCurrentAccountId(home) === accountId)
            clearCurrentAccount(home);
        return true;
    });
    if (!clearedCredentials)
        warning = 'The active credentials changed during logout and were preserved.';
    const responseEnvelope = {
        status: 'logged_out',
        authType: current.authType,
        clearedCredentials,
        revokedOnServer,
        warning,
    };
    if (options.json) {
        output(JSON.stringify(responseEnvelope, null, 2));
    }
    else {
        output(clearedCredentials ? '✓ Successfully logged out from BrainMCP. Local credentials removed.' : 'The previous authorization was logged out; the new active credentials were preserved.');
        if (warning) {
            output(`  Note: ${warning}`);
        }
    }
}
export async function whoami(options = {}) {
    const output = options.output ?? console.log;
    const { store, backend } = await resolveStore(options.store, true, options.runtimeHome);
    const apiClient = options.apiClient ?? new ApiClient({ store });
    const creds = await apiClient.getEffectiveCredentials();
    if (!creds) {
        const unauth = {
            status: 'unauthenticated',
        };
        if (options.json) {
            output(JSON.stringify(unauth, null, 2));
        }
        else {
            output('Not logged in. Run `brainmcp login` to authenticate.');
        }
        return unauth;
    }
    const prefs = readPreferences(options.runtimeHome ?? process.env.BRAINMCP_HOME ?? process.env.BRAIN_HOME);
    const reauthRequired = creds.authType === 'oauth' && Boolean(creds.reauthRequired);
    const responseEnvelope = {
        status: reauthRequired ? 'reauth_required' : 'authenticated',
        authType: creds.authType,
        userId: creds.userId ?? (creds.authType === 'service' ? SERVICE_ACCOUNT_ID : undefined),
        clientId: creds.clientId ?? (creds.authType === 'service' ? 'service-token' : BRAINMCP_CLI_CLIENT_ID),
        authorizationId: creds.authorizationId,
        workspaces: creds.workspaces ?? [],
        defaultWorkspaceId: creds.defaultWorkspaceId ?? null,
        scopes: creds.scopes ?? [],
        provenance: creds.provenance,
        storageBackend: creds.authType === 'service' && creds.serviceToken === process.env.BRAINMCP_SERVICE_TOKEN ? 'env' : backend,
        expiresAt: creds.expiresAt,
        captureEnabled: Boolean(prefs?.consent.captureEnabled),
    };
    if (options.json) {
        // Ensure no token is echoed
        output(JSON.stringify(responseEnvelope, null, 2));
    }
    else {
        output(reauthRequired
            ? 'Status: Sign-in expired or revoked. Run `brainmcp login` to sign in again.'
            : `Status: Authenticated (${creds.authType})`);
        if (responseEnvelope.clientId) {
            output(`Client: ${responseEnvelope.clientId}`);
        }
        if (responseEnvelope.workspaces && responseEnvelope.workspaces.length > 0) {
            output(`Authorized Workspaces: ${responseEnvelope.workspaces.join(', ')}`);
            if (responseEnvelope.defaultWorkspaceId) {
                output(`Default Workspace: ${responseEnvelope.defaultWorkspaceId}`);
            }
        }
        if (responseEnvelope.scopes && responseEnvelope.scopes.length > 0) {
            output(`Scopes: ${responseEnvelope.scopes.join(', ')}`);
        }
        if (responseEnvelope.storageBackend) {
            output(`Storage: ${responseEnvelope.storageBackend}`);
        }
        if (responseEnvelope.expiresAt) {
            output(`Expires: ${responseEnvelope.expiresAt}`);
        }
        output(`Capture: ${responseEnvelope.captureEnabled ? 'enabled' : 'disabled'}`);
        if (responseEnvelope.provenance) {
            output(`Consent Mode: ${responseEnvelope.provenance.consentMode} (${responseEnvelope.provenance.workspaceSelection})`);
        }
    }
    return responseEnvelope;
}
//# sourceMappingURL=auth.js.map