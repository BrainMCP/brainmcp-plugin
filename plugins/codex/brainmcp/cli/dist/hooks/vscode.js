export function parseVsCodeEvent(raw, eventName = 'sessionStart') {
    const input = (raw && typeof raw === 'object' ? raw : {});
    return {
        client: 'vscode',
        event: eventName,
        sessionKey: input.session_id || input.sessionId || 'default_session',
        cwd: input.cwd || input.workspace,
        source: input.source,
        prompt: input.prompt,
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_response,
        model: input.model,
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