import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const VAULT_SERVICE = 'brainmcp.credentials';
export const LEGACY_VAULT_ACCOUNT = 'oauth';
const VAULT_ACCOUNT = LEGACY_VAULT_ACCOUNT;
const EXEC_TIMEOUT_MS = 4_000;
export function vaultAccountKey(accountId) {
    return `oauth:${accountId}`;
}
/** `oauth`, or `oauth:` plus a `sanitizeAccountId` result (which may be `id-<hex>`). */
const VAULT_KEY_PATTERN = /^oauth(?::[A-Za-z0-9_-]{1,128})?$/;
/**
 * The OS vaults below put the key in a `security -i` command line or a
 * PowerShell string, so only the shapes BrainMCP itself produces may reach them.
 */
export function assertVaultKey(key) {
    if (!VAULT_KEY_PATTERN.test(key))
        throw new Error('Invalid credential vault key.');
}
/**
 * `security -i` reads its commands with a fixed-size line buffer: a line over
 * about 4096 bytes is split, so `add-generic-password -U` overwrites the good
 * item with a truncated value and the remainder runs as an unknown command.
 * Lines above this limit are never written.
 */
export const MACOS_SECURITY_MAX_LINE_BYTES = 4000;
/** A secret too large for the vault's input channel. Nothing was written. */
export class VaultValueTooLargeError extends Error {
    constructor(message = 'The credentials are too large for the OS credential vault; nothing was written.') {
        super(message);
        this.name = 'VaultValueTooLargeError';
    }
}
export function macosSecurityAddLine(value, key) {
    const hex = Buffer.from(value, 'utf8').toString('hex');
    return `add-generic-password -U -s ${VAULT_SERVICE} -a ${key} -w ${hex}\n`;
}
export class MemorySecretVault {
    name = 'memory';
    secrets = new Map();
    available = true;
    async isAvailable() {
        return this.available;
    }
    async getSecret(key = VAULT_ACCOUNT) {
        return this.secrets.get(key) ?? null;
    }
    async setSecret(value, key = VAULT_ACCOUNT) {
        this.secrets.set(key, value);
    }
    async deleteSecret(key = VAULT_ACCOUNT) {
        this.secrets.delete(key);
    }
}
export class UnavailableSecretVault {
    name = 'unavailable';
    async isAvailable() {
        return false;
    }
    async getSecret() {
        return null;
    }
    async setSecret() {
        throw new Error('OS credential vault is unavailable.');
    }
    async deleteSecret() { }
}
export class MacosSecurityVault {
    spawnProcess;
    constructor(spawnProcess = spawn) {
        this.spawnProcess = spawnProcess;
    }
    name = 'macos-keychain';
    async isAvailable() {
        try {
            await execFileAsync('which', ['security'], { timeout: EXEC_TIMEOUT_MS });
            return true;
        }
        catch {
            return false;
        }
    }
    async getSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', VAULT_SERVICE, '-a', key, '-w'], { timeout: EXEC_TIMEOUT_MS });
            const value = stdout.trim();
            if (!value)
                return null;
            if (value.startsWith('{'))
                return value;
            if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
                const decoded = Buffer.from(value, 'hex').toString('utf8');
                return decoded.length > 0 ? decoded : null;
            }
            return value;
        }
        catch {
            return null;
        }
    }
    async setSecret(value, key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        const line = macosSecurityAddLine(value, key);
        // Checked before spawning: an over-long line would replace the stored item
        // with a truncated (unusable) value.
        if (Buffer.byteLength(line, 'utf8') > MACOS_SECURITY_MAX_LINE_BYTES)
            throw new VaultValueTooLargeError();
        await new Promise((resolve, reject) => {
            const child = this.spawnProcess('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('macOS keychain store timed out'));
            }, EXEC_TIMEOUT_MS);
            const done = (fn) => {
                clearTimeout(timer);
                fn();
            };
            child.on('error', (error) => done(() => reject(error)));
            child.stdin.on('error', (error) => done(() => reject(error)));
            child.on('close', (code) => {
                if (code === 0)
                    done(() => resolve());
                else
                    done(() => reject(new Error('macOS keychain store failed')));
            });
            child.stdin.write(line);
            child.stdin.end();
        });
    }
    async deleteSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            await execFileAsync('security', ['delete-generic-password', '-s', VAULT_SERVICE, '-a', key], { timeout: EXEC_TIMEOUT_MS });
        }
        catch {
            // Missing item is success for logout.
        }
    }
}
export class LinuxSecretToolVault {
    spawnProcess;
    constructor(spawnProcess = spawn) {
        this.spawnProcess = spawnProcess;
    }
    name = 'libsecret';
    async isAvailable() {
        try {
            await execFileAsync('which', ['secret-tool'], { timeout: EXEC_TIMEOUT_MS });
            return true;
        }
        catch {
            return false;
        }
    }
    async getSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', VAULT_SERVICE, 'account', key], { timeout: EXEC_TIMEOUT_MS });
            const value = stdout.trim();
            return value.length > 0 ? value : null;
        }
        catch {
            return null;
        }
    }
    async setSecret(value, key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        await new Promise((resolve, reject) => {
            const child = this.spawnProcess('secret-tool', ['store', '--label', 'BrainMCP CLI', 'service', VAULT_SERVICE, 'account', key], { stdio: ['pipe', 'ignore', 'ignore'] });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('secret-tool store timed out'));
            }, EXEC_TIMEOUT_MS);
            const done = (fn) => {
                clearTimeout(timer);
                fn();
            };
            child.on('error', (error) => done(() => reject(error)));
            child.stdin.on('error', (error) => done(() => reject(error)));
            child.on('close', (code) => {
                if (code === 0)
                    done(() => resolve());
                else
                    done(() => reject(new Error('secret-tool store failed')));
            });
            child.stdin.write(value);
            child.stdin.end();
        });
    }
    async deleteSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            await execFileAsync('secret-tool', ['clear', 'service', VAULT_SERVICE, 'account', key], { timeout: EXEC_TIMEOUT_MS });
        }
        catch {
            // Missing item is success for logout.
        }
    }
}
export class WindowsCredentialVault {
    spawnProcess;
    constructor(spawnProcess = spawn) {
        this.spawnProcess = spawnProcess;
    }
    name = 'windows-credential-manager';
    async isAvailable() {
        return process.platform === 'win32';
    }
    async getSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            const { stdout } = await execFileAsync('powershell.exe', [
                '-NoProfile',
                '-Command',
                `try { $v = New-Object Windows.Security.Credentials.PasswordVault; ($v.Retrieve('${VAULT_SERVICE}','${key}')).Password } catch { '' }`,
            ], { timeout: EXEC_TIMEOUT_MS });
            const value = stdout.trim();
            return value.length > 0 ? value : null;
        }
        catch {
            return null;
        }
    }
    async setSecret(value, key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        await new Promise((resolve, reject) => {
            const child = this.spawnProcess('powershell.exe', [
                '-NoProfile',
                '-Command',
                `$svc='${VAULT_SERVICE}'; $acct='${key}'; $p=[Console]::In.ReadToEnd(); $v=New-Object Windows.Security.Credentials.PasswordVault; try { $v.Remove($v.Retrieve($svc,$acct)) } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential($svc,$acct,$p)))`,
            ], { stdio: ['pipe', 'ignore', 'ignore'] });
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('Windows PasswordVault store timed out'));
            }, EXEC_TIMEOUT_MS);
            const done = (fn) => {
                clearTimeout(timer);
                fn();
            };
            child.on('error', (error) => done(() => reject(error)));
            child.stdin.on('error', (error) => done(() => reject(error)));
            child.on('close', (code) => {
                if (code === 0)
                    done(() => resolve());
                else
                    done(() => reject(new Error('Windows PasswordVault store failed')));
            });
            child.stdin.write(value);
            child.stdin.end();
        });
    }
    async deleteSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            await execFileAsync('powershell.exe', [
                '-NoProfile',
                '-Command',
                `try { $v = New-Object Windows.Security.Credentials.PasswordVault; $v.Remove($v.Retrieve('${VAULT_SERVICE}','${key}')) } catch {}`,
            ], { timeout: EXEC_TIMEOUT_MS });
        }
        catch {
            // ignore
        }
    }
}
export function createPlatformVault() {
    if (process.platform === 'darwin')
        return new MacosSecurityVault();
    if (process.platform === 'linux')
        return new LinuxSecretToolVault();
    if (process.platform === 'win32')
        return new WindowsCredentialVault();
    return new UnavailableSecretVault();
}
//# sourceMappingURL=vault.js.map