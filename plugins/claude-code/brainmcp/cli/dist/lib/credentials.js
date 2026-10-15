import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withSessionLock } from '../runtime/lock.js';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotSymlink, ensureDirectory0700, getBrainHome, getCurrentAccountId, resolveStateDir, writeAtomic0600 } from '../runtime/storage.js';
import { createPlatformVault, UnavailableSecretVault, vaultAccountKey, LEGACY_VAULT_ACCOUNT } from './vault.js';
import { CREDENTIALS_SCHEMA_VERSION, InvalidJsonError, parseJsonWithoutEcho } from './cli-contracts.js';
/** A credentials record that cannot be used. The message never includes record contents. */
export class InvalidCredentialsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidCredentialsError';
    }
}
const OPTIONAL_STRING_FIELDS = [
    'accessToken',
    'refreshToken',
    'expiresAt',
    'clientId',
    'userId',
    'authorizationId',
    'serviceToken',
    'tokenEndpoint',
];
const OPTIONAL_STRING_ARRAY_FIELDS = ['scopes', 'workspaces'];
const OPTIONAL_OBJECT_FIELDS = ['provenance', 'refreshLease', 'reauthRequired'];
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
/**
 * Structural check of a parsed StoredCredentials record: schema version, auth
 * type, field types, and a usable secret for that type (an OAuth record needs
 * an access or refresh token, a service record its service token).
 */
export function validateStoredCredentials(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new InvalidCredentialsError('credentials must be a JSON object');
    }
    const record = data;
    if (record.version !== CREDENTIALS_SCHEMA_VERSION) {
        const version = typeof record.version === 'number' ? ` ${record.version}` : '';
        throw new InvalidCredentialsError(`unsupported credentials schema version${version}`);
    }
    if (record.authType !== 'oauth' && record.authType !== 'service') {
        throw new InvalidCredentialsError('authType must be "oauth" or "service"');
    }
    if (typeof record.updatedAt !== 'string') {
        throw new InvalidCredentialsError('updatedAt must be a string');
    }
    for (const field of OPTIONAL_STRING_FIELDS) {
        if (record[field] !== undefined && typeof record[field] !== 'string') {
            throw new InvalidCredentialsError(`${field} must be a string`);
        }
    }
    for (const field of OPTIONAL_STRING_ARRAY_FIELDS) {
        const value = record[field];
        if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
            throw new InvalidCredentialsError(`${field} must be an array of strings`);
        }
    }
    for (const field of OPTIONAL_OBJECT_FIELDS) {
        const value = record[field];
        if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
            throw new InvalidCredentialsError(`${field} must be an object`);
        }
    }
    if (record.defaultWorkspaceId !== undefined && record.defaultWorkspaceId !== null && typeof record.defaultWorkspaceId !== 'string') {
        throw new InvalidCredentialsError('defaultWorkspaceId must be a string or null');
    }
    if (record.authType === 'oauth' && !nonEmptyString(record.accessToken) && !nonEmptyString(record.refreshToken)) {
        throw new InvalidCredentialsError('OAuth credentials have neither an access token nor a refresh token');
    }
    if (record.authType === 'service' && !nonEmptyString(record.serviceToken)) {
        throw new InvalidCredentialsError('service credentials have no service token');
    }
    return record;
}
/** Parse and validate a stored credentials document; failures never echo its contents. */
export function parseStoredCredentials(raw) {
    return validateStoredCredentials(parseJsonWithoutEcho(raw, 'credentials'));
}
/**
 * A printable reason a credentials document could not be used. Only messages
 * this module wrote (or a filesystem error code) are shown, never record text.
 */
export function describeCredentialsError(error) {
    if (error instanceof InvalidJsonError || error instanceof InvalidCredentialsError)
        return error.message;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return typeof code === 'string' ? `could not be read (${code})` : 'could not be read';
}
// unsafe-logging-allowed: callers pass only fixed text or describeCredentialsError output, never a record or token.
const warnOnConsole = (message) => console.warn(`[brainmcp credentials] ${message}`);
export class MemoryCredentialStore {
    creds = null;
    locked = false;
    async get() {
        return this.creds ? JSON.parse(JSON.stringify(this.creds)) : null;
    }
    async set(credentials) {
        this.creds = JSON.parse(JSON.stringify(credentials));
    }
    async clear() {
        this.creds = null;
    }
    async adoptLegacySecret() { }
    async withRefreshLock(action) {
        while (this.locked) {
            await new Promise((r) => setTimeout(r, 20));
        }
        this.locked = true;
        try {
            return await action(await this.get());
        }
        finally {
            this.locked = false;
        }
    }
}
export class FileCredentialStore {
    lockContext = new AsyncLocalStorage();
    baseDir;
    warn;
    allowInsecure;
    constructor(options = {}) {
        this.baseDir = options.baseDir ?? getBrainHome();
        this.warn = options.warn ?? warnOnConsole;
        this.allowInsecure = options.allowInsecureModesForTesting ?? false;
    }
    credentialPaths() {
        const stateDir = this.lockContext.getStore() ?? resolveStateDir(this.baseDir);
        return {
            stateDir,
            filePath: join(stateDir, 'credentials.json'),
            lockPath: join(stateDir, 'credentials.lock'),
        };
    }
    assertSafePath(targetPath, checkFileExists = true) {
        if (this.allowInsecure)
            return;
        // Check directory
        const dir = dirname(targetPath);
        if (existsSync(dir)) {
            const dirStat = lstatSync(dir);
            if (dirStat.isSymbolicLink()) {
                throw new Error(`Insecure configuration: directory ${dir} is a symbolic link.`);
            }
            if (process.platform !== 'win32') {
                const mode = dirStat.mode & 0o777;
                if (mode !== 0o700) {
                    throw new Error(`Insecure permissions on ${dir}: permissions are ${mode.toString(8)}, must be 700.`);
                }
                if (process.getuid && dirStat.uid !== process.getuid()) {
                    throw new Error(`Insecure ownership: directory ${dir} is not owned by current user.`);
                }
            }
        }
        // Check target file if it exists
        if (existsSync(targetPath)) {
            const fileStat = lstatSync(targetPath);
            if (fileStat.isSymbolicLink()) {
                throw new Error(`Insecure configuration: file ${targetPath} is a symbolic link.`);
            }
            if (!fileStat.isFile()) {
                throw new Error(`Insecure configuration: ${targetPath} is not a regular file.`);
            }
            if (process.platform !== 'win32') {
                const mode = fileStat.mode & 0o777;
                if (mode !== 0o600) {
                    throw new Error(`Insecure permissions on ${targetPath}: permissions are ${mode.toString(8)}, must be 600.`);
                }
                if (process.getuid && fileStat.uid !== process.getuid()) {
                    throw new Error(`Insecure ownership: file ${targetPath} is not owned by current user.`);
                }
            }
        }
        else if (checkFileExists) {
            // File doesn't exist yet, which is fine
        }
    }
    ensureDirectory() {
        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        }
        else if (!this.allowInsecure) {
            const homeStat = lstatSync(this.baseDir);
            if (homeStat.isSymbolicLink()) {
                throw new Error(`Insecure configuration: directory ${this.baseDir} is a symbolic link.`);
            }
        }
        const paths = this.credentialPaths();
        ensureDirectory0700(paths.stateDir);
        this.assertSafePath(paths.filePath, false);
        return paths;
    }
    async get() {
        const { filePath } = this.credentialPaths();
        if (!existsSync(filePath)) {
            return null;
        }
        this.assertSafePath(filePath);
        try {
            const raw = readFileSync(filePath, 'utf-8');
            // Version-only check, as before: doctor applies the full validateStoredCredentials.
            const parsed = parseJsonWithoutEcho(raw, 'credentials file');
            if (parsed?.version !== CREDENTIALS_SCHEMA_VERSION) {
                const version = typeof parsed?.version === 'number' ? `: ${parsed.version}` : '';
                this.warn(`Unsupported credentials schema version${version}`);
                return null;
            }
            return parsed;
        }
        catch (error) {
            this.warn(`Failed to read credentials: ${describeCredentialsError(error)}`);
            return null;
        }
    }
    async set(credentials) {
        const { filePath, stateDir } = this.ensureDirectory();
        const tempFile = join(stateDir, `credentials.tmp.${process.pid}.${randomUUID()}`);
        const data = JSON.stringify(credentials, null, 2);
        // Write to temp file with mode 0600
        try {
            const fd = openSync(tempFile, constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0), 0o600);
            try {
                writeFileSync(fd, data, 'utf-8');
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            this.assertSafePath(tempFile);
            // Atomically rename
            renameSync(tempFile, filePath);
            this.assertSafePath(filePath);
        }
        catch (error) {
            try {
                if (existsSync(tempFile))
                    unlinkSync(tempFile);
            }
            catch {
                // Best-effort cleanup.
            }
            throw error;
        }
    }
    async clear() {
        const { filePath } = this.credentialPaths();
        if (existsSync(filePath)) {
            this.assertSafePath(filePath);
            unlinkSync(filePath);
        }
    }
    async adoptLegacySecret() { }
    async withRefreshLock(action) {
        const stateDir = this.credentialPaths().stateDir;
        return withSessionLock('credentials', () => this.lockContext.run(stateDir, async () => action(await this.get())), { baseDir: stateDir });
    }
}
export class VaultCredentialStore {
    vault;
    lockStore;
    baseDir;
    lockContext = new AsyncLocalStorage();
    constructor(vault, lockStore, baseDir) {
        this.vault = vault;
        this.lockStore = lockStore;
        this.baseDir = baseDir;
    }
    get backend() {
        return 'os_vault';
    }
    backendMarkerPath() {
        return join(this.lockContext.getStore()?.stateDir ?? resolveStateDir(this.baseDir ?? getBrainHome()), 'credentials.backend.json');
    }
    secretKey() {
        if (this.lockContext.getStore())
            return this.lockContext.getStore().key;
        const accountId = getCurrentAccountId(this.baseDir ?? getBrainHome());
        return accountId ? vaultAccountKey(accountId) : LEGACY_VAULT_ACCOUNT;
    }
    async get() {
        // A fresh/isolated Brain home must not probe or adopt another home's
        // machine-wide vault entry merely because it uses the same account key.
        if (!existsSync(this.backendMarkerPath()))
            return null;
        assertNotSymlink(this.backendMarkerPath());
        const raw = await this.vault.getSecret(this.secretKey());
        if (!raw)
            return null;
        try {
            const parsed = parseJsonWithoutEcho(raw, 'credentials');
            if (parsed?.version !== CREDENTIALS_SCHEMA_VERSION)
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    async set(credentials) {
        const marker = this.backendMarkerPath();
        await this.vault.setSecret(JSON.stringify(credentials), this.secretKey());
        ensureDirectory0700(dirname(marker));
        writeAtomic0600(marker, JSON.stringify({ backend: 'os_vault', updatedAt: new Date().toISOString() }));
    }
    async clear() {
        const marker = this.backendMarkerPath();
        await this.vault.deleteSecret(this.secretKey());
        if (existsSync(marker)) {
            assertNotSymlink(marker);
            unlinkSync(marker);
        }
    }
    async adoptLegacySecret() {
        const accountId = getCurrentAccountId(this.baseDir ?? getBrainHome());
        if (!accountId)
            return;
        const namespaced = vaultAccountKey(accountId);
        if (await this.vault.getSecret(namespaced))
            return;
        const legacy = await this.vault.getSecret(LEGACY_VAULT_ACCOUNT);
        if (!legacy)
            return;
        await this.vault.setSecret(legacy, namespaced);
        await this.vault.deleteSecret(LEGACY_VAULT_ACCOUNT);
        writeAtomic0600(this.backendMarkerPath(), JSON.stringify({ backend: 'os_vault', updatedAt: new Date().toISOString() }));
    }
    async withRefreshLock(action) {
        const context = { key: this.secretKey(), stateDir: resolveStateDir(this.baseDir ?? getBrainHome()) };
        return this.lockStore.withRefreshLock(() => this.lockContext.run(context, async () => action(await this.get())));
    }
}
export const FILE_CREDENTIALS_ACK_FILENAME = 'allow-file-credentials';
export function fileCredentialsAcknowledged(baseDir) {
    if (process.env.BRAINMCP_ALLOW_FILE_CREDENTIALS === '1')
        return true;
    const home = baseDir ?? getBrainHome();
    const acknowledgement = join(home, FILE_CREDENTIALS_ACK_FILENAME);
    if (!existsSync(acknowledgement))
        return false;
    const stat = lstatSync(acknowledgement);
    if (stat.isSymbolicLink() || !stat.isFile())
        return false;
    if (process.platform !== 'win32') {
        if ((stat.mode & 0o777) !== 0o600)
            return false;
        if (process.getuid && stat.uid !== process.getuid())
            return false;
    }
    return true;
}
export function writeFileCredentialsAcknowledgement(baseDir) {
    const home = baseDir ?? getBrainHome();
    ensureDirectory0700(home);
    writeAtomic0600(join(home, FILE_CREDENTIALS_ACK_FILENAME), JSON.stringify({ acknowledgedAt: new Date().toISOString() }));
}
export async function createDefaultCredentialStore(options = {}) {
    const warn = options.warn ?? warnOnConsole;
    const fileStore = new FileCredentialStore({
        baseDir: options.baseDir,
        warn,
    });
    const vault = options.vault ??
        (options.baseDir ? new UnavailableSecretVault() : createPlatformVault());
    const home = options.baseDir ?? getBrainHome();
    const existingFile = existsSync(join(resolveStateDir(home), 'credentials.json'));
    // An acknowledged file login remains usable when the OS vault later becomes
    // available. Only the active account's file determines that backend.
    if (existingFile)
        return { store: fileStore, backend: 'file' };
    if (await vault.isAvailable()) {
        return { store: new VaultCredentialStore(vault, fileStore, options.baseDir), backend: 'os_vault' };
    }
    const allowFile = options.allowFileCredentials === true ||
        existingFile ||
        fileCredentialsAcknowledged(options.baseDir);
    if (!allowFile) {
        throw new Error('OS credential vault is unavailable. Re-run `brainmcp login --allow-file-credentials` to store tokens in an owner-only ~/.brainmcp file (0700/0600, no symlinks).');
    }
    if (!existingFile) {
        warn('OS credential vault is unavailable; using the owner-only ~/.brainmcp file store. This is an explicit fallback, not the default.');
    }
    if (options.persistFileAcknowledgement) {
        writeFileCredentialsAcknowledgement(options.baseDir);
    }
    return { store: fileStore, backend: 'file' };
}
//# sourceMappingURL=credentials.js.map