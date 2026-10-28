import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import { BRAINMCP_CLI_CLIENT_ID, BRAINMCP_CLI_DEFAULT_SCOPES, } from '../agent-config.js';
import { ApiClient } from '../lib/api-client.js';
import { COMPANION_WORKSPACES_PATH } from '../lib/endpoints.js';
import { startCallbackServer } from '../lib/callback-server.js';
import { isWorkspaceUuid, normalizeWorkspaceId, } from '../lib/cli-contracts.js';
import { createDefaultCredentialStore, MemoryCredentialStore } from '../lib/credentials.js';
import { grantedCliScopes, OAuthClient } from '../lib/oauth-client.js';
export { grantedCliScopes } from '../lib/oauth-client.js';
import { generatePkce } from '../lib/pkce.js';
import { CAPTURE_DISCLOSURE, captureConsentOutdated, captureReconsentCommand, enableCapture, disableCapture } from '../runtime/capture.js';
import { migrateLegacyFlatState, switchCurrentAccount, clearCurrentAccount, getBrainHome, getCurrentAccountId, readPreferences, resolveStateDir, sanitizeAccountId, SERVICE_ACCOUNT_ID, } from '../runtime/storage.js';
import { clearOrientCache } from '../runtime/orient.js';
import { withSessionLock } from '../runtime/lock.js';
import { checkRuntimeDrift } from '../runtime/doctor-checks.js';
import { cliPackageVersion } from '../runtime/installer.js';
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
            .filter((id) => typeof id === 'string' && isWorkspaceUuid(id))
            .map(normalizeWorkspaceId))];
    if (ids.length === 0) {
        throw new Error('The OAuth server did not return an explicit companion workspace allowlist.');
    }
    const accountDefault = typeof listed.account?.defaultWorkspaceId === 'string'
        ? normalizeWorkspaceId(listed.account.defaultWorkspaceId)
        : '';
    if (accountDefault) {
        if (!ids.includes(accountDefault)) {
            throw new Error('The default workspace of this CLI grant is not among the workspaces it can reach (it may be archived or require two-factor authentication). Run `brainmcp login` again (with `--force` if already signed in) and choose a reachable default workspace.');
        }
        return { workspaces: ids, defaultWorkspaceId: accountDefault };
    }
    // Compatibility with responses that marked the default on the workspace row.
    const marked = [...new Set(rows
            .filter((workspace) => workspace?.isDefault === true && typeof workspace.id === 'string' && ids.includes(normalizeWorkspaceId(workspace.id)))
            .map((workspace) => normalizeWorkspaceId(workspace.id)))];
    if (marked.length === 1)
        return { workspaces: ids, defaultWorkspaceId: marked[0] };
    if (ids.length === 1)
        return { workspaces: ids, defaultWorkspaceId: ids[0] };
    throw new Error('The OAuth server did not return a default workspace for this multi-workspace CLI grant. Run `brainmcp login` again (with `--force` if already signed in) and choose a default workspace in the browser.');
}
async function resolveStore(store, allowFileCredentials, baseDir, fileFallbackOnVaultFailure) {
    if (store)
        return { store, backend: 'memory' };
    return createDefaultCredentialStore({
        baseDir,
        allowFileCredentials,
        persistFileAcknowledgement: allowFileCredentials,
        fileFallbackOnVaultFailure,
    });
}
/**
 * The command that hands `url` to the system browser. Windows uses rundll32,
 * not `cmd /c start`: cmd splits its command line at `&`, which cut the
 * authorize URL off after its first query parameter.
 */
export function browserOpenCommand(url, platform = process.platform) {
    if (platform === 'darwin')
        return { command: 'open', args: [url] };
    if (platform === 'win32')
        return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
    return { command: 'xdg-open', args: [url] };
}
/**
 * Settles once the opener has started, not when it exits: `xdg-open` can keep
 * running as long as the browser it launched, and login would wait on it.
 * `spawnProcess` exists so tests need not open a browser.
 */
export async function defaultOpenBrowser(url, platform = process.platform, spawnProcess = spawn) {
    const { command, args } = browserOpenCommand(url, platform);
    return await new Promise((resolve) => {
        const child = spawnProcess(command, args, { stdio: 'ignore', detached: true });
        child.once('error', () => resolve(false));
        child.once('spawn', () => resolve(true));
        child.unref();
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
/**
 * Commit local identity only after the remote exchange has finished. Resolves
 * to the record this sign-in overwrote in the account's store (null when the
 * account had none), so a re-login can revoke the grant it replaced.
 */
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
            const replaced = await input.store.withRefreshLock(async (latest) => {
                await input.store.set(input.credentials);
                return latest;
            });
            if (input.home)
                switchCurrentAccount(input.home, accountId);
            if (stateDir) {
                resetCompanionLocalState(stateDir);
                if (input.captureWorkspaceId)
                    enableCapture({ baseDir: stateDir, workspaceId: input.captureWorkspaceId });
            }
            return replaced;
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
    return input.home ? await withSessionLock('account-switch', commit, { baseDir: path.join(input.home, 'shared') }) : await commit();
}
/**
 * A re-login of the same account leaves the grant it replaced live on the
 * server until it expires, so it is revoked once the new sign-in is committed.
 * Best effort: a failure changes nothing locally. A grant marked for re-login,
 * one with a refresh in flight, or the new authorization itself is left alone:
 * Better Auth treats revoking a token a refresh already rotated as reuse and
 * deletes every CLI token the user holds, the new sign-in included. (The API's
 * refresh-family guard answers a token revoked from the dashboard as a no-op.)
 * Another account's grant stays in its own namespace and is never revoked here.
 */
export async function revokeReplacedCompanionGrant(input) {
    const { replaced, credentials } = input;
    const token = replaced?.authType === 'oauth' ? replaced.refreshToken || replaced.accessToken : undefined;
    const leaseExpiry = Date.parse(replaced?.refreshLease?.expiresAt ?? '');
    if (!token ||
        replaced.reauthRequired ||
        (Number.isFinite(leaseExpiry) && leaseExpiry > Date.now()) ||
        !replaced.userId ||
        replaced.userId !== credentials.userId ||
        replaced.authorizationId === credentials.authorizationId) {
        return 'skipped';
    }
    try {
        return await input.oauthClient.revokeToken({ revocationEndpoint: input.revocationEndpoint, token }) ? 'revoked' : 'failed';
    }
    catch {
        return 'failed';
    }
}
/**
 * Hooks installed by `brainmcp init` run the runtime it installed until init
 * reruns, so after a sign-in say when that runtime is not this CLI's (the
 * same check `doctor` reports as runtime drift).
 */
export function warnOnHookRuntimeDrift(home, warn) {
    if (!home || !fs.existsSync(path.join(home, 'runtime')))
        return;
    try {
        const drift = checkRuntimeDrift(cliPackageVersion(), home);
        if (!drift.passed) {
            warn(`Note: ${drift.detail}. Lifecycle hooks installed by \`brainmcp init\` keep running that runtime, which may not read this sign-in correctly; run \`brainmcp init\` to update them (\`brainmcp doctor\` shows which runtime hooks use).`);
        }
    }
    catch {
        // Advisory only; `doctor` reports an unreadable runtime directory.
    }
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
        : await resolveStore(options.store, options.allowFileCredentials, options.runtimeHome, options.allowFileCredentials);
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
        if (options.storeServiceToken)
            warnOnHookRuntimeDrift(companionRuntimeHome(options), options.json ? errorOutput : output);
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
    // `login --capture-digests` on a sign-in that lacks digests:write is the
    // documented way to add capture, so it re-authorizes for the added scope
    // instead of demanding --force (through 0.1.38 it refused).
    const addsDigestScope = Boolean(options.captureDigests && existing?.authType === 'oauth' &&
        !existing.scopes?.includes('digests:write'));
    if (existing && !options.force && !existing.reauthRequired && !addsDigestScope) {
        throw new Error(!options.captureDigests
            ? 'Already authenticated. Pass --force to replace the stored companion credentials.'
            : existing.authType === 'service'
                // A service token has no OAuth scopes and can never capture digests.
                ? 'Signed in with a stored service token, which cannot capture digests. Pass --force (`brainmcp login --capture-digests --force`) to replace it with an interactive sign-in that includes digest capture (digests:write).'
                : 'Already authenticated with digest capture (digests:write). Run `brainmcp capture enable` to turn capture on, or pass --force (`brainmcp login --capture-digests --force`) to sign in again.');
    }
    const force = options.force || addsDigestScope;
    const scopes = [...BRAINMCP_CLI_DEFAULT_SCOPES];
    if (options.captureDigests) {
        scopes.push('digests:write');
    }
    const pkce = generatePkce();
    // Discovery first: the callback checks the response's `iss` against the
    // discovered issuer (RFC 9207).
    const endpoints = await oauthClient.discoverEndpoints();
    const callbackServer = await startCallbackServer({
        expectedIssuer: endpoints.issuer,
        expectedState: pkce.state,
        timeoutMs: 300_000,
    });
    try {
        const authUrl = oauthClient.buildAuthorizationUrl({
            authorizationEndpoint: endpoints.authorizationEndpoint,
            redirectUri: callbackServer.redirectUri,
            pkce,
            scopes,
        });
        const humanOutput = options.json ? errorOutput : output;
        if (addsDigestScope) {
            humanOutput('You are signed in without digest capture; re-authorizing to add the digests:write scope. Your current sign-in stays until the new one completes.');
        }
        if (options.captureDigests) {
            humanOutput(CAPTURE_DISCLOSURE);
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
        const replaced = await commitCompanionCredentials({ home, store, credentials: credentialsRecord, force,
            captureWorkspaceId: options.captureDigests && credentialsRecord.scopes?.includes('digests:write')
                ? credentialsRecord.defaultWorkspaceId ?? undefined : undefined });
        const replacedGrant = await revokeReplacedCompanionGrant({ oauthClient, revocationEndpoint: endpoints.revocationEndpoint,
            replaced, credentials: credentialsRecord });
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
            output(`  Scopes: ${responseEnvelope.scopes.join(', ')}`);
            output('  This companion grant is for CLI hooks and orientation only.');
            output('  Host agents still need their own MCP OAuth (for Cursor: Settings → Tools & MCP → brain).');
        }
        if (replacedGrant === 'failed') {
            humanOutput('Note: the server did not confirm revoking the sign-in this one replaced; it expires on its own, or revoke it from the dashboard.');
        }
        warnOnHookRuntimeDrift(home, humanOutput);
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
        // An earlier logout removed the marker but the OS vault refused to delete
        // its copy (CredentialClearError): finish it, along with the local reset
        // that logout skipped. A vault that still refuses throws the same error.
        // (retryPendingClear deletes only while no marker, so no new sign-in, exists.)
        const finished = Boolean(await store.retryPendingClear?.());
        if (finished) {
            if (stateDir)
                resetCompanionLocalState(stateDir);
            if (home && getCurrentAccountId(home) === accountId)
                clearCurrentAccount(home);
        }
        const res = {
            status: 'logged_out',
            clearedCredentials: finished,
        };
        if (options.json) {
            output(JSON.stringify(res, null, 2));
        }
        else {
            output(finished
                ? '✓ Finished the earlier logout: removed the sign-in the OS credential vault had kept.'
                : 'Not currently logged in.');
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
        // A vault that refuses the delete throws CredentialClearError: the local
        // marker is gone (nothing reads the grant), the account stays selected so
        // the next `brainmcp logout` finds and retries the pending delete.
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
            ? creds.reauthRequired?.reason === 'credentials_incomplete'
                ? `Status: Stored sign-in is incomplete (${creds.reauthRequired.detail}). Run \`brainmcp login\` to sign in again.`
                : 'Status: Sign-in expired or revoked. Run `brainmcp login` to sign in again.'
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
        output(`Capture: ${captureConsentOutdated(prefs)
            ? `paused (the capture policy changed; run \`${captureReconsentCommand(prefs)}\` to accept it)`
            : responseEnvelope.captureEnabled ? 'enabled' : 'disabled'}`);
        if (responseEnvelope.provenance) {
            output(`Consent Mode: ${responseEnvelope.provenance.consentMode} (${responseEnvelope.provenance.workspaceSelection})`);
        }
    }
    return responseEnvelope;
}
//# sourceMappingURL=auth.js.map