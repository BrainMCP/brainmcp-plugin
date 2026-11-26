import path from 'node:path';
import os from 'node:os';
export function getCodexHome() {
    if (process.env.CODEX_HOME) {
        return path.resolve(process.env.CODEX_HOME);
    }
    return path.join(os.homedir(), '.codex');
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function parseCodexEvent(raw, eventName = 'SessionStart') {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const sessionId = asString(input.session_id);
    return {
        client: 'codex',
        event: eventName,
        sessionKey: sessionId && sessionId.length > 0 ? sessionId : 'default_session',
        cwd: asString(input.cwd),
        source: asString(input.source),
        transcriptPath: asString(input.transcript_path),
        status: asString(input.status) ?? asString(input.reason),
        prompt: asString(input.prompt),
        toolName: asString(input.tool_name),
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_response,
        model: asString(input.model),
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