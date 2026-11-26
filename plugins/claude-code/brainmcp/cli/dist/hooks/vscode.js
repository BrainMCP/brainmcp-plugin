function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function parseVsCodeEvent(raw, eventName = 'sessionStart') {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const sessionId = asString(input.session_id) || asString(input.sessionId);
    return {
        client: 'vscode',
        event: eventName,
        sessionKey: sessionId || 'default_session',
        cwd: asString(input.cwd) || asString(input.workspace),
        source: asString(input.source),
        prompt: asString(input.prompt),
        toolName: asString(input.tool_name),
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_response,
        model: asString(input.model),
    };
}
export function emitVsCodeOutput(event, additionalContext) {
    if ((event.event === 'SessionStart' || event.event === 'sessionStart') && additionalContext) {
        return {
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext,
            },
        };
    }
    return {};
}
//# sourceMappingURL=vscode.js.map