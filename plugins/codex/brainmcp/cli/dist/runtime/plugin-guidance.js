import fs from 'node:fs';
import path from 'node:path';
import { buildCompactInstructionBlock } from '../agent-config.js';
import { MARKER_END, MARKER_START } from '../lib/config.js';
import { claudeConfigDir, codexHomeDir } from '../lib/host-plugins.js';
/**
 * Most UTF-8 bytes a plugin SessionStart puts in its one `additionalContext`
 * string. Past its cap a host saves the text to a file and shows the agent only
 * a preview (read 2026-10-15):
 * - Claude Code caps each hook string at 10,000 characters and previews the
 *   first 2,000 (code.claude.com/docs/en/hooks, "JSON output").
 * - Codex caps each hook's context at 2,500 tokens, estimated as UTF-8 bytes / 4,
 *   so 10,000 bytes, and previews its head and tail (openai/codex e89b7c44,
 *   codex-rs/hooks/src/output_spill.rs and utils/string/src/truncate.rs). A
 *   hook's `additionalContextLimit` raises that cap, but the plugin's
 *   hooks.json stays byte-stable because Codex keys hook trust to its text.
 * A string never has more characters than UTF-8 bytes, so one byte budget
 * covers both hosts; it keeps a 1,000-byte margin below their caps.
 */
export const PLUGIN_SESSION_START_MAX_BYTES = 9_000;
/** Larger instruction files are not read; the plugin then sends its own guidance. */
const INSTRUCTION_FILE_MAX_BYTES = 1024 * 1024;
const CONTEXT_SEPARATOR = '\n\n';
function readInstructionFile(file) {
    try {
        // A FIFO or device would block the read; only regular files are instructions.
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > INSTRUCTION_FILE_MAX_BYTES)
            return undefined;
        return fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** Whether `text` holds a complete managed block that `init` wrote at this guidance version. */
export function hasCurrentManagedBlock(text) {
    if (!text)
        return false;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const start = lines.indexOf(MARKER_START);
    return start >= 0 && lines.indexOf(MARKER_END, start + 1) > start;
}
/**
 * The CLAUDE.md files Claude Code loads for a session started in `root`: its
 * own and every ancestor's up to the Git root, where `init --scope project`
 * writes. A session opened in a subdirectory used to miss the root's block and
 * receive the guidance a second time. Outside a Git repository, only the
 * root's own file counts.
 */
function projectInstructionCandidates(root, name) {
    const start = path.resolve(root);
    const directories = [];
    for (let directory = start;; directory = path.dirname(directory)) {
        directories.push(directory);
        if (fs.existsSync(path.join(directory, '.git')))
            return directories.map((entry) => path.join(entry, name));
        if (path.dirname(directory) === directory)
            return [path.join(start, name)];
    }
}
/**
 * The always-on instruction files where `init` writes its managed block and
 * the host loads it every session.
 * - Claude Code: the user CLAUDE.md in its config directory, and for each
 *   project root the CLAUDE.md files from it up to its Git root
 *   (`init --scope project`); any one of them counts for that root.
 * - Codex: CODEX_HOME's AGENTS.override.md when it has text, else AGENTS.md,
 *   the order Codex reads them in. A project AGENTS.md does not count: Codex
 *   skips it in a project the user has not trusted and caps project
 *   instructions at `project_doc_max_bytes`.
 */
function managedInstructionFiles(host, roots, lookup) {
    if (host === 'claude-code') {
        return {
            user: path.join(claudeConfigDir(lookup), 'CLAUDE.md'),
            projects: roots.map((root) => projectInstructionCandidates(root, 'CLAUDE.md')),
        };
    }
    if (host === 'codex') {
        const home = codexHomeDir(lookup);
        const override = path.join(home, 'AGENTS.override.md');
        return { user: readInstructionFile(override)?.trim() ? override : path.join(home, 'AGENTS.md'), projects: [] };
    }
    return { projects: [] };
}
/**
 * Whether the host already loads `init`'s guidance at this version every
 * session: from its user file, or from the project file at every root.
 */
export function hostLoadsCurrentManagedGuidance(host, roots, lookup) {
    const files = managedInstructionFiles(host, roots, lookup);
    if (files.user && hasCurrentManagedBlock(readInstructionFile(files.user)))
        return true;
    return files.projects.length > 0 &&
        files.projects.every((candidates) => candidates.some((file) => hasCurrentManagedBlock(readInstructionFile(file))));
}
function utf8Bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}
/** Clips `text` to `maxBytes` UTF-8 bytes on a code point boundary, ending with "…". */
export function clipUtf8(text, maxBytes) {
    if (utf8Bytes(text) <= maxBytes)
        return text;
    const ellipsis = '…';
    const bytes = Buffer.from(text, 'utf8');
    let end = Math.max(0, maxBytes - utf8Bytes(ellipsis));
    // Step back over continuation bytes so a multi-byte character stays whole.
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end -= 1;
    return `${bytes.subarray(0, end).toString('utf8')}${ellipsis}`;
}
/**
 * SessionStart context from a BrainMCP plugin's own hook. A plugin cannot
 * write CLAUDE.md or AGENTS.md, so the hook carries the compact always-on
 * guidance ahead of the orientation or sign-in text, signed in or not. When
 * the host already loads `init`'s managed block at this guidance version, the
 * guidance would only repeat it, so the hook sends what `init`'s own hook
 * sends. An older block still gets the current guidance.
 */
export function pluginSessionStartContext(context, input) {
    if (hostLoadsCurrentManagedGuidance(input.host, input.roots, input.lookup))
        return context;
    const guidance = buildCompactInstructionBlock();
    const contextBudget = PLUGIN_SESSION_START_MAX_BYTES - utf8Bytes(guidance) - utf8Bytes(CONTEXT_SEPARATOR);
    return `${guidance}${CONTEXT_SEPARATOR}${clipUtf8(context, contextBudget)}`;
}
//# sourceMappingURL=plugin-guidance.js.map