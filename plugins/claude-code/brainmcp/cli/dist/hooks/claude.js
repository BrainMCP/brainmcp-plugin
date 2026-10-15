export function parseClaudeEvent(raw, eventName = 'SessionStart') {
    const input = (raw && typeof raw === 'object' ? raw : {});
    return {
        client: 'claude-code',
        event: eventName,
        sessionKey: input.session_id || 'default_session',
        cwd: input.cwd,
        source: input.source,
        transcriptPath: input.transcript_path,
        prompt: input.prompt,
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolResult: input.tool_response ?? input.tool_result,
        stopHookActive: Boolean(input.stop_hook_active),
        model: input.model,
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