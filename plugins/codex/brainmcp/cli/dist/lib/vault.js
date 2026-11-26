import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const VAULT_SERVICE = 'brainmcp.credentials';
export const LEGACY_VAULT_ACCOUNT = 'oauth';
const VAULT_ACCOUNT = LEGACY_VAULT_ACCOUNT;
const EXEC_TIMEOUT_MS = 4_000;
/** `security` reports errSecItemNotFound as exit 44. */
const MACOS_ITEM_NOT_FOUND_EXIT = 44;
/** ERROR_NOT_FOUND (0x80070490) as PowerShell's signed HResult. */
const WINDOWS_NOT_FOUND_HRESULT = -2147023728;
/**
 * Opens the vault as `$v` at the start of every Windows script, or exits WINDOWS_VAULT_UNAVAILABLE_EXIT.
 * Windows PowerShell 5.1 finds a WinRT class only after its type is loaded by this assembly-qualified
 * name: without it, `New-Object Windows.Security.Credentials.PasswordVault` fails with "Cannot find
 * type". PowerShell 7 has no WinRT, so the scripts run under powershell.exe. A machine without the
 * Credential Locker, or a PowerShell held in Constrained Language Mode, still cannot load it.
 */
export const WINDOWS_OPEN_VAULT = "$ErrorActionPreference = 'Stop'; try { " +
    '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; ' +
    '[void][Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]; ' +
    '$v = New-Object Windows.Security.Credentials.PasswordVault } catch { exit 3 }; ';
/** How a Windows vault script reports that PowerShell cannot load the vault at all. */
export const WINDOWS_VAULT_UNAVAILABLE_EXIT = 3;
export const WINDOWS_VAULT_UNAVAILABLE_MESSAGE = 'Windows PowerShell cannot load the Windows credential vault (no Credential Locker, or Constrained Language Mode). ' +
    'Run `brainmcp login --allow-file-credentials` to use the owner-only file store instead.';
/** The most stderr a failed Windows store keeps: enough for the HRESULT line it prints. */
const WINDOWS_STDERR_LIMIT = 1024;
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
    runCommand;
    constructor(spawnProcess = spawn, runCommand = execFileAsync) {
        this.spawnProcess = spawnProcess;
        this.runCommand = runCommand;
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
            await this.runCommand('security', ['delete-generic-password', '-s', VAULT_SERVICE, '-a', key], { timeout: EXEC_TIMEOUT_MS });
        }
        catch (error) {
            // Only a missing item counts as deleted; a locked keychain or a timeout left it in place.
            if (error.code !== MACOS_ITEM_NOT_FOUND_EXIT)
                throw new Error('macOS keychain delete failed');
        }
    }
}
export class LinuxSecretToolVault {
    spawnProcess;
    runCommand;
    constructor(spawnProcess = spawn, runCommand = execFileAsync) {
        this.spawnProcess = spawnProcess;
        this.runCommand = runCommand;
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
            await this.runCommand('secret-tool', ['clear', 'service', VAULT_SERVICE, 'account', key], { timeout: EXEC_TIMEOUT_MS });
        }
        catch (error) {
            // `secret-tool clear` exits 1 both ways: silently when nothing matched, with the error on
            // stderr when it failed. A timeout or a missing tool has no exit status of 1.
            const { code, stderr } = error;
            if (code !== 1 || String(stderr ?? '').trim() !== '')
                throw new Error('secret-tool delete failed');
        }
    }
}
export class WindowsCredentialVault {
    spawnProcess;
    runCommand;
    constructor(spawnProcess = spawn, runCommand = execFileAsync) {
        this.spawnProcess = spawnProcess;
        this.runCommand = runCommand;
    }
    name = 'windows-credential-manager';
    /**
     * Any Windows machine. Whether PowerShell can load the vault is learned from the scripts themselves
     * (WINDOWS_VAULT_UNAVAILABLE_EXIT): a separate check would start PowerShell once more in every
     * hook, whose budget each start already strains.
     */
    async isAvailable() {
        return process.platform === 'win32';
    }
    async getSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        try {
            const result = await this.runCommand('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `${WINDOWS_OPEN_VAULT}try { ($v.Retrieve('${VAULT_SERVICE}','${key}')).Password } catch { '' }`,
            ], { timeout: EXEC_TIMEOUT_MS });
            const value = String(result?.stdout ?? '').trim();
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
                '-NonInteractive',
                '-Command',
                // The secret arrives on stdin, never in the command line, and is read first so the pipe is
                // drained whatever happens next. A failure prints only its HRESULTs.
                `$p = [Console]::In.ReadToEnd(); ${WINDOWS_OPEN_VAULT}try { $svc='${VAULT_SERVICE}'; $acct='${key}'; try { $v.Remove($v.Retrieve($svc,$acct)) } catch {}; $v.Add((New-Object Windows.Security.Credentials.PasswordCredential($svc,$acct,$p))) } catch { [Console]::Error.WriteLine('HRESULT ' + $_.Exception.HResult + ' ' + $_.Exception.InnerException.HResult); exit 1 }`,
            ], { stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
                if (stderr.length < WINDOWS_STDERR_LIMIT)
                    stderr = `${stderr}${String(chunk)}`.slice(0, WINDOWS_STDERR_LIMIT);
            });
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
                else if (code === WINDOWS_VAULT_UNAVAILABLE_EXIT)
                    done(() => reject(new Error(WINDOWS_VAULT_UNAVAILABLE_MESSAGE)));
                else
                    done(() => reject(new Error(`Windows PasswordVault store failed${windowsFailureDetail(stderr)}`)));
            });
            child.stdin.write(value);
            child.stdin.end();
        });
    }
    async deleteSecret(key = VAULT_ACCOUNT) {
        assertVaultKey(key);
        // Exits 0 only when the item was removed or Retrieve says it is not there. PowerShell can wrap
        // the COM exception, so the inner one is checked too.
        await this.runCommand('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `${WINDOWS_OPEN_VAULT}try { $c = $v.Retrieve('${VAULT_SERVICE}','${key}') } catch { if (@($_.Exception.HResult, $_.Exception.InnerException.HResult) -contains ${WINDOWS_NOT_FOUND_HRESULT}) { exit 0 }; exit 1 }; try { $v.Remove($c) } catch { exit 1 }`,
        ], { timeout: EXEC_TIMEOUT_MS }).catch(() => {
            throw new Error('Windows PasswordVault delete failed');
        });
    }
}
/**
 * The HRESULTs a failed Windows store printed, as hex, so a report names the cause. Nothing else from
 * stderr is repeated: PowerShell echoes script text there.
 */
export function windowsFailureDetail(stderr) {
    const codes = /HRESULT (-?\d+)(?: (-?\d+))?/.exec(stderr)?.slice(1).filter((code) => code !== undefined && code !== '');
    if (!codes?.length)
        return '';
    const hex = [...new Set(codes)].map((code) => `0x${(Number(code) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`);
    return ` (HRESULT ${hex.join(', ')})`;
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