function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const strings = value.filter((item) => typeof item === 'string');
    return strings.length > 0 ? strings : undefined;
}
export function parseCursorEvent(raw, eventName = 'sessionStart') {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const sessionId = asString(input.session_id) || asString(input.conversation_id);
    return {
        client: 'cursor',
        event: eventName,
        sessionKey: sessionId || 'default_session',
        workspaceRoots: asStringArray(input.workspace_roots),
        cwd: asString(input.cwd),
        prompt: asString(input.prompt),
        assistantText: asString(input.text),
        toolName: asString(input.tool_name),
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_output,
        status: asString(input.final_status) ?? asString(input.reason),
        model: asString(input.model_id) ?? asString(input.model),
    };
}
export function emitCursorOutput(event, additionalContext) {
    if (event.event === 'sessionStart' && additionalContext) {
        return {
            additional_context: additionalContext,
        };
    }
    return {};
}
//# sourceMappingURL=cursor.js.map