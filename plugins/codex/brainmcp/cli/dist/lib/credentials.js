import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withSessionLock } from '../runtime/lock.js';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotSymlink, ensureDirectory0700, getBrainHome, getCurrentAccountId, readSafeJson, resolveStateDir, writeAtomic0600 } from '../runtime/storage.js';
import { createPlatformVault, UnavailableSecretVault, vaultAccountKey, LEGACY_VAULT_ACCOUNT, MACOS_SECURITY_MAX_LINE_BYTES, macosSecurityAddLine, VaultValueTooLargeError, } from './vault.js';
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
/** The OS vault refused to delete the sign-in; the local marker is gone, so it is no longer used. */
export class CredentialClearError extends Error {
    constructor() {
        super('The local sign-in was removed, but the OS credential vault refused to delete its copy (is the keychain or keyring locked?). Unlock it and run `brainmcp logout` again to finish.');
        this.name = 'CredentialClearError';
    }
}
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
/**
 * The OS vault item normally holds the whole record, exactly as 0.1.38 and
 * earlier wrote and read it: a hook runtime pinned to an older CLI (until
 * `brainmcp init` reruns) reads the vault item alone. Only a record whose
 * macOS `security -i` line would overflow (a grant with many workspaces, see
 * vault.ts) is split: its tokens stay in the vault and everything else
 * (workspaces, scopes, provenance, refresh lease, ...) goes to the owner-only
 * backend marker file.
 *
 * A split item carries SPLIT_VAULT_FORMAT and no `version`, so an older
 * runtime reads it as "no credentials" instead of a grant without identity
 * that its next refresh would write back over the record.
 */
const SPLIT_VAULT_FORMAT = 'brainmcp.vault-split.v1';
const VAULT_TOKEN_FIELDS = ['authType', 'accessToken', 'refreshToken', 'serviceToken'];
/**
 * Both halves of one split write carry the same random pair id, so a reader
 * never joins a vault item with the marker half of another write.
 */
const SPLIT_PAIR_FIELD = 'splitPairId';
/**
 * A split record goes back to one whole vault item only once that item's
 * `security -i` line is this far under the limit, so a record near the line
 * (a refresh lease adds about 115 bytes) does not flip layouts every refresh.
 */
const WHOLE_LAYOUT_MAX_FRACTION = 0.9;
export function splitVaultCredentials(credentials, pairId) {
    const secret = { format: SPLIT_VAULT_FORMAT };
    const metadata = {};
    for (const [field, value] of Object.entries(credentials)) {
        if (value === undefined)
            continue;
        if (VAULT_TOKEN_FIELDS.includes(field))
            secret[field] = value;
        else
            metadata[field] = value;
    }
    if (pairId) {
        secret[SPLIT_PAIR_FIELD] = pairId;
        metadata[SPLIT_PAIR_FIELD] = pairId;
    }
    return { secret, metadata };
}
function metadataObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
/**
 * The backend marker's split metadata (null when it has none), or why the
 * marker could not be read (wrong mode or owner, not a regular file, corrupt JSON).
 */
export function readVaultMarker(markerPath) {
    try {
        const marker = metadataObject(readSafeJson(markerPath));
        if (!marker)
            return { metadata: null, previousMetadata: null };
        const layout = marker.layout === 'whole' || marker.layout === 'split' ? marker.layout : undefined;
        return { metadata: metadataObject(marker.metadata), previousMetadata: metadataObject(marker.previousMetadata), ...(layout ? { layout } : {}) };
    }
    catch (error) {
        // readSafeJson's own messages name only the path, mode, and owner.
        return { metadata: null, previousMetadata: null, error: error instanceof Error ? error.message : 'could not be read' };
    }
}
/** Pre-fix development builds (never published) split with `version` and no `updatedAt` (every whole record has one). */
function isSplitVaultItem(item) {
    return item.format === SPLIT_VAULT_FORMAT || (item.version !== undefined && item.updatedAt === undefined);
}
/**
 * The vault item read together with the backend marker. A whole record stands
 * on its own (marker metadata, possibly stale, is ignored); a split item needs
 * the marker's metadata. Throws InvalidJsonError for a corrupt vault item.
 */
export function readVaultRecord(raw, markerPath) {
    const item = parseJsonWithoutEcho(raw, 'credentials');
    const marker = readVaultMarker(markerPath);
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return { kind: 'record', record: item, markerError: marker.error };
    const secret = item;
    if (!isSplitVaultItem(secret))
        return { kind: 'record', record: secret, markerError: marker.error };
    const incomplete = (detail, mismatch) => ({
        kind: 'incomplete',
        authType: secret.authType,
        detail,
        ...(nonEmptyString(secret.refreshToken) ? { refreshToken: secret.refreshToken } : {}),
        ...(mismatch ? { mismatch } : {}),
    });
    if (marker.error) {
        return incomplete(`credential marker unreadable (mode/owner): ${marker.error}. The OS vault holds only the tokens of this sign-in; its account, workspaces, and scopes are in that file`);
    }
    if (!marker.metadata) {
        return incomplete('credential marker has no sign-in details (an older BrainMCP runtime rewrote it). The OS vault holds only the tokens of this sign-in; its account, workspaces, and scopes are gone');
    }
    // Both halves of one write (items and markers written before pair ids carry none).
    const pairId = secret[SPLIT_PAIR_FIELD];
    const metadata = [marker.metadata, marker.previousMetadata].find((candidate) => candidate && candidate[SPLIT_PAIR_FIELD] === pairId);
    if (!metadata) {
        return incomplete('credential marker belongs to another save of this sign-in than the OS vault item (another BrainMCP process was saving it, or that save failed half way)', true);
    }
    const merged = { ...metadata };
    for (const field of [...VAULT_TOKEN_FIELDS, SPLIT_PAIR_FIELD])
        delete merged[field];
    const { format: _format, [SPLIT_PAIR_FIELD]: _pairId, ...tokens } = secret;
    return { kind: 'record', record: { ...merged, ...tokens } };
}
function writeVaultMarker(markerPath, fields) {
    ensureDirectory0700(dirname(markerPath));
    const marker = { backend: 'os_vault', updatedAt: new Date().toISOString() };
    if (fields.layout)
        marker.layout = fields.layout;
    if (fields.metadata)
        marker.metadata = fields.metadata;
    if (fields.previousMetadata)
        marker.previousMetadata = fields.previousMetadata;
    writeAtomic0600(markerPath, JSON.stringify(marker));
}
/** How long get() waits before re-reading a split item whose halves did not match. */
const SPLIT_MISMATCH_RETRY_MS = 100;
/**
 * Names the vault key whose delete a clear() could not finish, beside the
 * (already removed) marker, so the next logout retries it. Never a secret.
 */
const PENDING_VAULT_DELETE_FILENAME = 'credentials.vault-delete-pending.json';
/** The marker as stored, to put back after a failed split write; null when it is absent or unreadable. */
function readSafeJsonOrNull(path) {
    try {
        return readSafeJson(path);
    }
    catch {
        return null;
    }
}
const TOO_LARGE_FOR_VAULT = 'The credentials are too large for the OS credential vault; nothing was written and the stored sign-in is unchanged. Run `brainmcp login --force --allow-file-credentials` to store them in an owner-only ~/.brainmcp file (0700/0600, no symlinks).';
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
    pendingDeletePath() {
        return join(dirname(this.backendMarkerPath()), PENDING_VAULT_DELETE_FILENAME);
    }
    async readOnce(marker) {
        const raw = await this.vault.getSecret(this.secretKey());
        if (!raw)
            return null;
        try {
            return readVaultRecord(raw, marker);
        }
        catch {
            return null;
        }
    }
    async get() {
        // A fresh/isolated Brain home must not probe or adopt another home's
        // machine-wide vault entry merely because it uses the same account key.
        const marker = this.backendMarkerPath();
        if (!existsSync(marker))
            return null;
        assertNotSymlink(marker);
        let read = await this.readOnce(marker);
        if (read?.kind === 'incomplete' && read.mismatch) {
            // A writer between its two halves (set() writes the marker first and
            // keeps the previous half): read both again once it has finished.
            await new Promise((resolve) => setTimeout(resolve, SPLIT_MISMATCH_RETRY_MS));
            if (!existsSync(marker))
                return null;
            read = await this.readOnce(marker);
        }
        if (!read)
            return null;
        if (read.kind === 'incomplete') {
            // Never a stripped grant: without its identity a refresh would write the
            // tokens back as a record that no longer names its account or workspaces.
            // The refresh token stays so logout can revoke it; reauthRequired blocks
            // every request and refresh.
            if (read.authType !== 'oauth')
                return null;
            const now = new Date().toISOString();
            return {
                version: CREDENTIALS_SCHEMA_VERSION,
                authType: 'oauth',
                ...(read.refreshToken ? { refreshToken: read.refreshToken } : {}),
                reauthRequired: { reason: 'credentials_incomplete', detail: read.detail, detectedAt: now },
                updatedAt: now,
            };
        }
        const parsed = read.record;
        if (parsed?.version !== CREDENTIALS_SCHEMA_VERSION)
            return null;
        return parsed;
    }
    /**
     * The whole record in one vault item when it fits, so an older hook runtime
     * (which reads the vault item alone) still reads it; else split, tokens in
     * the vault and the rest in the marker. Concurrent readers (hooks) never see
     * a split item without its half: a split write puts its half in the marker
     * first and keeps the previous write's half beside it, and both halves carry
     * one pair id. A whole write leaves the marker's split halves in place (a
     * whole item ignores them) for a reader that read the earlier split item.
     * Once split, the record stays split until the whole item would be at least
     * 10% under the line limit, so a refresh lease does not flip the layout.
     */
    async set(credentials) {
        const marker = this.backendMarkerPath();
        const key = this.secretKey();
        const before = readVaultMarker(marker);
        const wasSplit = before.layout === 'split' || (before.layout === undefined && before.metadata !== null);
        const whole = JSON.stringify(credentials);
        const staySplit = wasSplit &&
            Buffer.byteLength(macosSecurityAddLine(whole, key), 'utf8') > MACOS_SECURITY_MAX_LINE_BYTES * WHOLE_LAYOUT_MAX_FRACTION;
        if (!staySplit) {
            // The vault first: if it refuses (locked, ...) nothing changes.
            let fits = true;
            try {
                await this.vault.setSecret(whole, key);
            }
            catch (error) {
                if (!(error instanceof VaultValueTooLargeError))
                    throw error;
                fits = false;
            }
            if (fits) {
                writeVaultMarker(marker, {
                    layout: 'whole',
                    // Halves an earlier split write left are kept only for a reader of that write.
                    ...(wasSplit ? { metadata: before.metadata ?? undefined, previousMetadata: before.previousMetadata ?? undefined } : {}),
                });
                this.dropPendingDelete();
                return;
            }
        }
        const { secret, metadata } = splitVaultCredentials(credentials, randomUUID());
        const markerExisted = existsSync(marker);
        const restore = before.error ? null : readSafeJsonOrNull(marker);
        writeVaultMarker(marker, { layout: 'split', metadata, previousMetadata: before.metadata ?? undefined });
        try {
            await this.vault.setSecret(JSON.stringify(secret), key);
        }
        catch (error) {
            // The vault item is unchanged, so the marker goes back to what it was
            // (none: get() must not start reading a vault item this home never wrote).
            try {
                if (!markerExisted)
                    unlinkSync(marker);
                else if (restore)
                    writeAtomic0600(marker, JSON.stringify(restore));
            }
            catch {
                // previousMetadata still pairs with the unchanged vault item.
            }
            if (error instanceof VaultValueTooLargeError)
                throw new VaultValueTooLargeError(TOO_LARGE_FOR_VAULT);
            throw error;
        }
        this.dropPendingDelete();
    }
    dropPendingDelete() {
        try {
            const pending = this.pendingDeletePath();
            if (existsSync(pending))
                unlinkSync(pending);
        }
        catch {
            // A stale record only makes the next signed-out logout delete this key again.
        }
    }
    /**
     * The marker first: it gates get(), so a vault delete that fails cannot
     * leave a readable grant. That failure is recorded beside the marker and
     * thrown as CredentialClearError, so the next logout (which finds no
     * marker) retries the delete through retryPendingClear().
     */
    async clear() {
        const marker = this.backendMarkerPath();
        const key = this.secretKey();
        try {
            if (existsSync(marker)) {
                assertNotSymlink(marker);
                unlinkSync(marker);
            }
        }
        finally {
            await this.deleteVaultItem(key);
        }
    }
    async deleteVaultItem(key) {
        try {
            await this.vault.deleteSecret(key);
        }
        catch {
            try {
                writeAtomic0600(this.pendingDeletePath(), JSON.stringify({ key, recordedAt: new Date().toISOString() }));
            }
            catch {
                // Reported below either way.
            }
            throw new CredentialClearError();
        }
        this.dropPendingDelete();
    }
    async retryPendingClear() {
        const pendingPath = this.pendingDeletePath();
        let key;
        try {
            key = metadataObject(readSafeJson(pendingPath))?.key;
        }
        catch {
            return false;
        }
        // Only this home's own key: never another home's machine-wide item.
        if (key !== this.secretKey()) {
            this.dropPendingDelete();
            return false;
        }
        if (existsSync(this.backendMarkerPath())) {
            // A sign-in was saved since; logout clears it normally.
            this.dropPendingDelete();
            return false;
        }
        await this.deleteVaultItem(key);
        return true;
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
        const marker = this.backendMarkerPath();
        const current = readVaultMarker(marker);
        writeVaultMarker(marker, {
            ...(current.layout ? { layout: current.layout } : {}),
            metadata: current.metadata ?? undefined,
            previousMetadata: current.previousMetadata ?? undefined,
        });
    }
    async withRefreshLock(action) {
        const context = { key: this.secretKey(), stateDir: resolveStateDir(this.baseDir ?? getBrainHome()) };
        return this.lockStore.withRefreshLock(() => this.lockContext.run(context, async () => action(await this.get())));
    }
}
/**
 * The OS vault, falling back to the owner-only file store when a vault write
 * fails. Used only when the user passed `--allow-file-credentials`, so an
 * available-but-failing vault (locked keychain, oversized record, ...) does not
 * block sign-in. Once the file exists it is the backend for this home.
 */
export class VaultWithFileFallbackStore {
    vaultStore;
    fileStore;
    baseDir;
    warn;
    constructor(vaultStore, fileStore, baseDir, warn) {
        this.vaultStore = vaultStore;
        this.fileStore = fileStore;
        this.baseDir = baseDir;
        this.warn = warn;
    }
    fileExists() {
        return existsSync(join(resolveStateDir(this.baseDir ?? getBrainHome()), 'credentials.json'));
    }
    async get() {
        return this.fileExists() ? this.fileStore.get() : this.vaultStore.get();
    }
    async set(credentials) {
        if (this.fileExists())
            return this.fileStore.set(credentials);
        try {
            await this.vaultStore.set(credentials);
        }
        catch {
            this.warn('The OS credential vault refused the credentials; using the owner-only ~/.brainmcp file store (--allow-file-credentials).');
            await this.fileStore.set(credentials);
            // The file is now authoritative; drop the vault copy so the two cannot
            // diverge. clear() removes the marker first, so even a failed vault
            // delete leaves nothing a later run (after logout) would read.
            await this.vaultStore.clear().catch(() => undefined);
        }
    }
    async clear() {
        await this.fileStore.clear();
        await this.vaultStore.clear();
    }
    async retryPendingClear() {
        return this.vaultStore.retryPendingClear();
    }
    async adoptLegacySecret() {
        if (!this.fileExists())
            await this.vaultStore.adoptLegacySecret();
    }
    async withRefreshLock(action) {
        return this.fileExists() ? this.fileStore.withRefreshLock(action) : this.vaultStore.withRefreshLock(action);
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
        const vaultStore = new VaultCredentialStore(vault, fileStore, options.baseDir);
        if (options.fileFallbackOnVaultFailure) {
            return { store: new VaultWithFileFallbackStore(vaultStore, fileStore, options.baseDir, warn), backend: 'os_vault' };
        }
        return { store: vaultStore, backend: 'os_vault' };
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