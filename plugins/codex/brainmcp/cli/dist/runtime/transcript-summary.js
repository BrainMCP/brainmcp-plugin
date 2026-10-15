import fs from 'node:fs';
import path from 'node:path';
/**
 * Session summaries for hosts whose hooks carry no assistant text. Claude Code
 * and Codex send `last_assistant_message` only on Stop, which never captures
 * (AHI-D03) and which the plugins' hooks.json does not register. Every hook
 * they send does carry `transcript_path`, the session's JSONL transcript, so
 * the capture triggers (PreCompact, SessionEnd) read the assistant's closing
 * message of each recent turn from its tail.
 *
 * Both formats are internal to their hosts and change between versions
 * (code.claude.com/docs/en/sessions; the Codex hooks docs say the same), so
 * every field is optional here and an unrecognized line is skipped. Only
 * assistant reply text is kept: never user prompts, tool calls or results,
 * reasoning, or anything else in the file. Capture consent covers "stable
 * assistant summaries" and excludes transcripts.
 *
 * Line shapes read (2026-10-15):
 * - Claude Code: `{type:"user"|"assistant", isSidechain?, isMeta?,
 *   isCompactSummary?, isApiErrorMessage?, message:{content: string |
 *   [{type:"text",text} | {type:"tool_use"} | {type:"tool_result"} |
 *   {type:"thinking"}]}}`. A user line with prompt text starts a turn.
 * - Codex (openai/codex 2a6ecbb9, `RolloutLine`): `{type:"event_msg",
 *   payload:{type:"task_started"}}` starts a turn and
 *   `{type:"event_msg", payload:{type:"task_complete",
 *   last_agent_message}}` ends it; assistant text is
 *   `{type:"response_item", payload:{type:"message", role:"assistant",
 *   content:[{type:"output_text",text}]}}`.
 */
/** Most bytes read from the end of a transcript; earlier turns are not needed. */
export const TRANSCRIPT_TAIL_MAX_BYTES = 1024 * 1024;
/** Turns whose closing assistant message a summary keeps, newest last. */
export const TRANSCRIPT_SUMMARY_MAX_TURNS = 3;
/** Characters kept of one closing message (code points). */
export const TRANSCRIPT_SUMMARY_TURN_MAX_CHARS = 1_500;
/**
 * Characters of the whole summary. The digest keeps at most 4,000 UTF-8 bytes
 * of a summary (`buildDigestPayload`), so mostly-ASCII text fits whole.
 */
export const TRANSCRIPT_SUMMARY_MAX_CHARS = 3_800;
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/** Text of the blocks whose `type` is `blockType`, joined by newlines. */
function blockText(content, blockType) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => {
        const record = asRecord(block);
        return record?.type === blockType && typeof record.text === 'string' ? record.text : '';
    })
        .filter((text) => text.trim().length > 0)
        .join('\n');
}
/** A Claude Code user line that holds a prompt (not a tool result, meta or compaction note). */
function isClaudePrompt(line) {
    if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true)
        return false;
    const content = asRecord(line.message)?.content;
    if (typeof content === 'string')
        return content.trim().length > 0;
    if (!Array.isArray(content))
        return false;
    const types = content.map((block) => asRecord(block)?.type);
    return types.includes('text') && !types.includes('tool_result');
}
/** The text of a Claude Code assistant line in the main thread, or ''. */
function claudeAssistantText(line) {
    if (line.isSidechain === true || line.isMeta === true || line.isApiErrorMessage === true)
        return '';
    const message = asRecord(line.message);
    if (!message || message.model === '<synthetic>')
        return '';
    return typeof message.content === 'string' ? message.content : blockText(message.content, 'text');
}
/** The text of a Codex assistant `response_item` message, or ''. */
function codexAssistantText(payload) {
    if (payload?.type !== 'message' || payload.role !== 'assistant')
        return '';
    return blockText(payload.content, 'output_text');
}
/**
 * The closing assistant message of each turn found in the lines, oldest
 * first. A turn's closing message is the last assistant text before the next
 * turn starts, which skips the progress notes an assistant writes between
 * tool calls. The first turn may have started before the lines did.
 */
export function transcriptTurnReplies(lines) {
    const replies = [];
    let current;
    const endTurn = () => {
        if (current !== undefined && current !== replies[replies.length - 1])
            replies.push(current);
        current = undefined;
    };
    for (const raw of lines) {
        if (!raw.trim())
            continue;
        let line;
        try {
            line = asRecord(JSON.parse(raw));
        }
        catch {
            continue;
        }
        if (!line)
            continue;
        let text = '';
        switch (line.type) {
            case 'user':
                if (isClaudePrompt(line))
                    endTurn();
                break;
            case 'assistant':
                text = claudeAssistantText(line);
                break;
            case 'response_item':
                text = codexAssistantText(asRecord(line.payload));
                break;
            case 'event_msg': {
                const payload = asRecord(line.payload);
                if (payload?.type === 'task_started' || payload?.type === 'turn_started')
                    endTurn();
                else if (payload?.type === 'task_complete' || payload?.type === 'turn_complete') {
                    const last = payload.last_agent_message;
                    if (typeof last === 'string' && last.trim())
                        current = last.trim();
                    endTurn();
                }
                break;
            }
            default:
                break;
        }
        if (text.trim())
            current = text.trim();
    }
    endTurn();
    return replies;
}
function normalizeReply(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function clipCodePoints(text, max) {
    const codePoints = Array.from(text);
    return codePoints.length <= max ? text : `${codePoints.slice(0, max - 1).join('')}…`;
}
/**
 * The digest summary for a set of turn replies: the closing messages of the
 * newest turns, oldest first, each clipped, dropping the oldest until the
 * whole fits. Undefined when there is no reply.
 */
export function formatTranscriptSummary(replies) {
    let kept = replies
        .map(normalizeReply)
        .filter(Boolean)
        .slice(-TRANSCRIPT_SUMMARY_MAX_TURNS)
        .map((reply) => clipCodePoints(reply, TRANSCRIPT_SUMMARY_TURN_MAX_CHARS));
    const render = (items) => [
        `Closing assistant message of the latest ${items.length === 1 ? 'turn' : `${items.length} turns, oldest first`}:`,
        ...items.map((item, index) => (items.length === 1 ? item : `[${index + 1}] ${item}`)),
    ].join('\n\n');
    while (kept.length > 1 && Array.from(render(kept)).length > TRANSCRIPT_SUMMARY_MAX_CHARS)
        kept = kept.slice(1);
    if (kept.length === 0)
        return undefined;
    return { summary: clipCodePoints(render(kept), TRANSCRIPT_SUMMARY_MAX_CHARS), turns: kept.length };
}
/** The last `maxBytes` of a regular file, starting at a line boundary. */
function readTail(filePath, maxBytes) {
    // O_NOFOLLOW refuses a symlink swapped in after the lstat check, and
    // O_NONBLOCK keeps a FIFO swapped in from blocking the hook until fstat
    // refuses it (neither exists on Windows; a regular file reads the same).
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(filePath, flags);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
            throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
        const length = Math.min(stat.size, maxBytes);
        const start = stat.size - length;
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
            const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
            if (read === 0)
                break;
            offset += read;
        }
        const text = buffer.subarray(0, offset).toString('utf8');
        if (start === 0)
            return text;
        // The window began inside a line; drop that partial line.
        const newline = text.indexOf('\n');
        return newline >= 0 ? text.slice(newline + 1) : '';
    }
    finally {
        fs.closeSync(fd);
    }
}
/**
 * Read a host transcript's tail and summarize its latest turns. Only an
 * absolute path to a regular `.jsonl` file that is not a symlink is read, and
 * never more than `maxTailBytes`. Synchronous and bounded, so it fits the
 * hook budget: about 1 MiB of JSON lines parses in a few milliseconds.
 */
export function readTranscriptSummary(transcriptPath, options = {}) {
    if (!transcriptPath || !path.isAbsolute(transcriptPath))
        return { failure: 'not_absolute' };
    if (path.extname(transcriptPath) !== '.jsonl')
        return { failure: 'not_jsonl' };
    let stat;
    try {
        stat = fs.lstatSync(transcriptPath, { throwIfNoEntry: false });
    }
    catch {
        return { failure: 'read_error' };
    }
    if (!stat)
        return { failure: 'missing' };
    if (stat.isSymbolicLink() || !stat.isFile())
        return { failure: 'not_regular_file' };
    if (stat.size === 0)
        return { failure: 'empty' };
    let text;
    try {
        text = readTail(transcriptPath, Math.max(1, options.maxTailBytes ?? TRANSCRIPT_TAIL_MAX_BYTES));
    }
    catch (error) {
        const code = error?.code;
        return { failure: code === 'ELOOP' || code === 'ENOTFILE' ? 'not_regular_file' : 'read_error' };
    }
    const formatted = formatTranscriptSummary(transcriptTurnReplies(text.split('\n')));
    return formatted ?? { failure: 'no_assistant_text' };
}
//# sourceMappingURL=transcript-summary.js.map