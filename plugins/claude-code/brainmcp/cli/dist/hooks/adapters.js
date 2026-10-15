import { parseClaudeEvent, emitClaudeOutput } from './claude.js';
import { parseCodexEvent, emitCodexOutput } from './codex.js';
import { parseCursorEvent, emitCursorOutput } from './cursor.js';
import { parseVsCodeEvent, emitVsCodeOutput } from './vscode.js';
export const SUPPORTED_HOOK_HOSTS = ['claude-code', 'codex', 'cursor', 'vscode'];
/**
 * Returns true only if the client officially supports lifecycle hooks (AHI-065).
 * Antigravity, Copilot CLI, generic, and cloud agents return false.
 */
export function supportsHooks(client) {
    return SUPPORTED_HOOK_HOSTS.includes(client);
}
export function parseHostEvent(client, raw, eventName) {
    switch (client) {
        case 'claude-code':
            return parseClaudeEvent(raw, eventName);
        case 'codex':
            return parseCodexEvent(raw, eventName);
        case 'cursor':
            return parseCursorEvent(raw, eventName);
        case 'vscode':
            return parseVsCodeEvent(raw, eventName);
        default:
            throw new Error(`Unsupported hook host: ${client}`);
    }
}
export function emitHostOutput(client, event, additionalContext) {
    switch (client) {
        case 'claude-code':
            return emitClaudeOutput(event, additionalContext);
        case 'codex':
            return emitCodexOutput(event, additionalContext);
        case 'cursor':
            return emitCursorOutput(event, additionalContext);
        case 'vscode':
            return emitVsCodeOutput(event, additionalContext);
        default:
            return {};
    }
}
//# sourceMappingURL=adapters.js.map