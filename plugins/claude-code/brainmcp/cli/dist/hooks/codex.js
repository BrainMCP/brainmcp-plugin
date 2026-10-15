import path from 'node:path';
import os from 'node:os';
export function getCodexHome() {
    if (process.env.CODEX_HOME) {
        return path.resolve(process.env.CODEX_HOME);
    }
    return path.join(os.homedir(), '.codex');
}
export function parseCodexEvent(raw, eventName = 'SessionStart') {
    const input = (raw && typeof raw === 'object' ? raw : {});
    return {
        client: 'codex',
        event: eventName,
        sessionKey: input.session_id || 'default_session',
        cwd: input.cwd,
        source: input.source,
        status: input.status ?? input.reason,
        prompt: input.prompt,
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_response,
        model: input.model,
    };
}
export function emitCodexOutput(event, additionalContext) {
    if (event.event === 'SessionStart' && additionalContext) {
        return {
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext,
            },
        };
    }
    return {};
}
//# sourceMappingURL=codex.js.map