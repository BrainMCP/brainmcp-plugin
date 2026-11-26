function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function parseClaudeEvent(raw, eventName = 'SessionStart') {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    const sessionId = asString(input.session_id);
    return {
        client: 'claude-code',
        event: eventName,
        sessionKey: sessionId && sessionId.length > 0 ? sessionId : 'default_session',
        cwd: asString(input.cwd),
        source: asString(input.source),
        transcriptPath: asString(input.transcript_path),
        prompt: asString(input.prompt),
        toolName: asString(input.tool_name),
        toolInput: input.tool_input,
        toolResult: input.tool_response ?? input.tool_result,
        stopHookActive: input.stop_hook_active === true,
        model: asString(input.model),
    };
}
export function emitClaudeOutput(event, additionalContext) {
    if (event.event === 'StopNudge' && !event.stopHookActive && additionalContext) {
        return { decision: 'block', reason: additionalContext };
    }
    // Stop hook must NEVER queue or flush digests, and returns empty object
    if (event.event === 'Stop' || event.stopHookActive) {
        return {};
    }
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
//# sourceMappingURL=claude.js.map