export function parseCursorEvent(raw, eventName = 'sessionStart') {
    const input = (raw && typeof raw === 'object' ? raw : {});
    return {
        client: 'cursor',
        event: eventName,
        sessionKey: input.session_id || input.conversation_id || 'default_session',
        workspaceRoots: input.workspace_roots,
        cwd: input.cwd,
        prompt: input.prompt,
        assistantText: input.text,
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolResult: input.tool_result ?? input.tool_output,
        status: input.final_status ?? input.reason,
        model: input.model_id ?? input.model,
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