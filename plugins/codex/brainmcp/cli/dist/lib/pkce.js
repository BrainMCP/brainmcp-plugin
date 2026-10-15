import { createHash, randomBytes } from 'node:crypto';
export function base64UrlEncode(buffer) {
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
/**
 * Generate PKCE verifier, challenge (S256), and state (AHI-032).
 * Optional randomSource allows deterministic testing vectors.
 */
export function generatePkce(randomSource = randomBytes) {
    // RFC 7636: verifier length between 43 and 128 characters
    // 32 bytes of entropy encoded as base64url gives 43 chars
    const verifierBytes = randomSource(32);
    const verifier = base64UrlEncode(verifierBytes);
    const hash = createHash('sha256').update(verifier, 'ascii').digest();
    const challenge = base64UrlEncode(hash);
    const stateBytes = randomSource(24);
    const state = base64UrlEncode(stateBytes);
    return {
        verifier,
        challenge,
        method: 'S256',
        state,
    };
}
export function computeS256Challenge(verifier) {
    const hash = createHash('sha256').update(verifier, 'ascii').digest();
    return base64UrlEncode(hash);
}
//# sourceMappingURL=pkce.js.map