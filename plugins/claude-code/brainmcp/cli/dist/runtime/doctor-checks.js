import fs from 'node:fs';
import path from 'node:path';
import { validatePreferencesRecord } from '../lib/cli-contracts.js';
import { describeCredentialsError, parseStoredCredentials } from '../lib/credentials.js';
import { getBrainHome, getCurrentAccountId, readSafeJson, resolveStateDir } from './storage.js';
import { listInstalledRuntimes, readRuntimeShimTarget } from './installer.js';
import { listQueueItems } from './queue.js';
import { createPlatformVault, LEGACY_VAULT_ACCOUNT, vaultAccountKey } from '../lib/vault.js';
import { describeMisdirectedCompanionApi, resolveCompanionApiUrl } from '../lib/endpoints.js';
export async function checkCredentialHealth(baseDir, options) {
    const home = baseDir ?? getBrainHome();
    const stateDir = resolveStateDir(home);
    const credPath = path.join(stateDir, 'credentials.json');
    const backendMarker = path.join(stateDir, 'credentials.backend.json');
    const markerPresent = fs.existsSync(backendMarker);
    if (fs.existsSync(credPath)) {
        return readFileCredentialHealth(credPath);
    }
    const vault = options?.vault ?? (options?.probeVault ? createPlatformVault() : null);
    if (vault && markerPresent) {
        try {
            if (await vault.isAvailable()) {
                const accountId = getCurrentAccountId(home);
                const raw = await vault.getSecret(accountId ? vaultAccountKey(accountId) : LEGACY_VAULT_ACCOUNT);
                if (raw) {
                    let credentials;
                    try {
                        credentials = parseStoredCredentials(raw);
                    }
                    catch (error) {
                        return {
                            name: 'credential health',
                            passed: false,
                            detail: `OS vault secret is unreadable: ${describeCredentialsError(error)}`,
                            repairGuidance: 'Run "brainmcp login --force" to recreate credentials',
                        };
                    }
                    return storedCredentialHealth(credentials, 'OS credential vault');
                }
            }
        }
        catch {
            // Fall through to marker / empty handling; never leak vault errors.
        }
    }
    if (markerPresent) {
        return {
            name: 'credential health',
            passed: false,
            detail: 'OS vault marker present but no readable grant',
            repairGuidance: 'Run "brainmcp login --force" to recreate credentials',
        };
    }
    return {
        name: 'credential health',
        passed: true,
        detail: 'no credentials stored (run brainmcp login)',
        repairGuidance: 'Run "brainmcp login" to connect your agent to BrainMCP',
    };
}
function storedCredentialHealth(credentials, location) {
    if (credentials.authType === 'oauth')
        return oauthGrantHealth(credentials, location);
    return {
        name: 'credential health',
        passed: true,
        detail: `service token stored in ${location}`,
    };
}
function oauthGrantHealth(raw, location) {
    const scopes = raw.scopes ?? [];
    const label = `OAuth grant (${scopes.join(', ') || 'no scopes'})`;
    // The server's verdict on the refresh token is what decides grant health.
    if (raw.reauthRequired) {
        return {
            name: 'credential health',
            passed: false,
            detail: `${label} was rejected by the server (refresh token invalid or revoked) in ${location}`,
            repairGuidance: 'Run "brainmcp login" to sign in again',
        };
    }
    // A lapsed access token is routine: it refreshes on the next request as long
    // as a refresh token exists, so it is not a failure on its own.
    const accessExpired = typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt).getTime() < Date.now() : false;
    const canRefresh = typeof raw.refreshToken === 'string' && raw.refreshToken.length > 0;
    if (accessExpired && !canRefresh) {
        return {
            name: 'credential health',
            passed: false,
            detail: `${label} expired with no refresh token in ${location}`,
            repairGuidance: 'Run "brainmcp login" to sign in again',
        };
    }
    return {
        name: 'credential health',
        passed: true,
        detail: `${label} valid in ${location}${accessExpired ? ' (access token refreshes on next use)' : ''}`,
    };
}
function readFileCredentialHealth(credPath) {
    let credentials;
    try {
        // Same record and validator as the credential store (lib/credentials.ts).
        credentials = parseStoredCredentials(fs.readFileSync(credPath, 'utf8'));
    }
    catch (error) {
        return {
            name: 'credential health',
            passed: false,
            detail: `invalid credentials file: ${describeCredentialsError(error)}`,
            repairGuidance: 'Run "brainmcp login --force" to reset corrupt credentials',
        };
    }
    return storedCredentialHealth(credentials, 'credentials.json');
}
export function checkRuntimeDrift(expectedVersion, baseDir) {
    const installed = listInstalledRuntimes(baseDir);
    // Managed hook commands name the shim, so it decides which runtime hooks run.
    // Without one, an earlier init's hooks name a versioned runtime directly.
    const shimTarget = readRuntimeShimTarget(baseDir);
    if (shimTarget !== undefined && (shimTarget !== expectedVersion || !installed.some((r) => r.version === shimTarget))) {
        return {
            name: 'runtime bundle',
            passed: false,
            detail: installed.some((r) => r.version === shimTarget)
                ? `managed hooks run v${shimTarget}; current CLI is v${expectedVersion}`
                : `managed hooks run v${shimTarget}, which is not installed; current CLI is v${expectedVersion}`,
            repairGuidance: 'Run "brainmcp init" to update runtime to current version',
        };
    }
    if (installed.length === 0) {
        return {
            name: 'runtime bundle',
            passed: true, // Optional until hooks installed
            detail: 'no hook runtime bundle installed in ~/.brainmcp/runtime',
            repairGuidance: 'Run "brainmcp init" to install current runtime bundle',
        };
    }
    const hasCurrent = installed.some((r) => r.version === expectedVersion);
    if (hasCurrent) {
        return {
            name: 'runtime bundle',
            passed: true,
            detail: `version v${expectedVersion} installed and up to date`,
        };
    }
    const versions = installed.map((r) => `v${r.version}`).join(', ');
    return {
        name: 'runtime bundle',
        passed: false,
        detail: `runtime drift detected: installed [${versions}], current CLI is v${expectedVersion}`,
        repairGuidance: 'Run "brainmcp init" to update runtime to current version',
    };
}
export function checkConsentPreferences(baseDir) {
    const prefPath = path.join(resolveStateDir(baseDir), 'preferences.json');
    if (!fs.existsSync(prefPath)) {
        return {
            name: 'capture consent',
            passed: true,
            detail: 'default preferences (capture disabled by default)',
        };
    }
    try {
        const prefs = readSafeJson(prefPath, validatePreferencesRecord);
        if (!prefs) {
            return {
                name: 'capture consent',
                passed: false,
                detail: 'unreadable preferences file',
                repairGuidance: 'Run "brainmcp login" to reconfigure preferences',
            };
        }
        const capture = prefs.consent.captureEnabled ? 'enabled' : 'disabled';
        const prompts = prefs.consent.includePrompts ? 'with prompts' : 'no prompts';
        return {
            name: 'capture consent',
            passed: true,
            detail: `capture ${capture} (${prompts}) under policy ${prefs.consent.policyVersion}`,
        };
    }
    catch (err) {
        return {
            name: 'capture consent',
            passed: false,
            detail: `corrupt preferences: ${err instanceof Error ? err.message : String(err)}`,
            repairGuidance: 'Delete the current account preferences file under ~/.brainmcp/accounts/ or reconfigure with "brainmcp login"',
        };
    }
}
export function checkCompanionApiTarget(env = process.env) {
    try {
        const apiUrl = resolveCompanionApiUrl(env);
        const misdirected = describeMisdirectedCompanionApi(apiUrl);
        if (misdirected) {
            return {
                name: 'companion API origin',
                passed: false,
                detail: misdirected,
                repairGuidance: 'Unset BRAINMCP_API_URL or set it to https://api.brainmcp.ai',
            };
        }
        return {
            name: 'companion API origin',
            passed: true,
            detail: `REST ${apiUrl} (OAuth discovery stays on the MCP origin unless BRAINMCP_OAUTH_ISSUER is set)`,
        };
    }
    catch (err) {
        return {
            name: 'companion API origin',
            passed: false,
            detail: err instanceof Error ? err.message : String(err),
            repairGuidance: 'Unset BRAINMCP_API_URL or set it to https://api.brainmcp.ai',
        };
    }
}
export function checkQueueStatus(baseDir) {
    try {
        const items = listQueueItems(baseDir);
        const pending = items.filter((i) => i.status === 'pending');
        const failed = items.filter((i) => i.status === 'failed' || i.status === 'delivery_unknown');
        if (items.length === 0) {
            return {
                name: 'capture queue',
                passed: true,
                detail: 'queue clean (0 pending items)',
            };
        }
        const hasFailed = failed.length > 0;
        return {
            name: 'capture queue',
            passed: !hasFailed,
            detail: `${pending.length} pending, ${failed.length} failed out of ${items.length} total`,
            repairGuidance: hasFailed ? 'Run "brainmcp capture purge-local" to clear failed items' : undefined,
        };
    }
    catch (err) {
        return {
            name: 'capture queue',
            passed: false,
            detail: `error reading queue: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
//# sourceMappingURL=doctor-checks.js.map