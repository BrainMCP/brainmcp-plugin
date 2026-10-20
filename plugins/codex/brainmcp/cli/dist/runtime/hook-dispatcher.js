import crypto from 'node:crypto';
import { CAPTURE_POLICY_VERSION } from '../agent-config.js';
import { filterRelativePaths } from '../lib/cli-contracts.js';
import { emitHostOutput } from '../hooks/adapters.js';
import { markSessionNudged, queueSessionCapture, recordSessionEvent } from './session.js';
import { logRuntimeEvent } from './diagnostics.js';
import { getBrainHome, readPreferences, resolveStateDir } from './storage.js';
import { pruneLocalState } from './retention.js';
import { withRequestDeadline } from '../lib/http.js';
import { captureTriggerForEvent, tryCaptureProjectKey, buildDigestPayload, collectGitMetadata, isCaptureEligible, captureConsentActive, isStopEvent, readProjectCaptureRestrictions, projectBindingBlocksCapture, queueProjectRoots, resolveCaptureWorkspaceId, serializeDigestPayload, } from './capture.js';
import { canEnqueueCapture } from './flush.js';
import { readTranscriptSummary } from './transcript-summary.js';
import { isSessionStartEvent, isUserPromptEvent, loginOrientationMessage, safeSessionStartOrientation, SESSION_START_MAX_TIMEOUT_MS, SESSION_START_TIMEOUT_MS, } from './orient.js';
import { pluginSessionStartContext } from './plugin-guidance.js';
import { ApiClient } from '../lib/api-client.js';
import { detectHostPlugin, isPluginHost, pluginRunsHook } from '../lib/host-plugins.js';
import { createDefaultCredentialStore } from '../lib/credentials.js';
export const MAX_STDIN_BYTES = 1024 * 1024; // 1 MB
export const DEFAULT_EVENT_TIMEOUT_MS = 1000;
/**
 * SessionEnd only commits local state and may start background delivery (no
 * network), and Codex stops SessionEnd hooks after at most three seconds (the
 * managed `timeout: 3`; its default is one). With the runtime's
 * input headroom the whole-process deadline is 2.5 s, which leaves Node startup
 * inside that cap.
 */
export const SESSION_END_TIMEOUT_MS = 2000;
/**
 * Claude Code cancels SessionEnd hooks after one shared 1.5 s budget, and a
 * plugin's own `timeout` cannot raise it (code.claude.com/docs/en/hooks,
 * "SessionEnd"). Node startup and the input headroom come first, so the
 * dispatch, Git metadata included, gets 700 ms and the queue write still lands
 * before the host cancels the hook.
 */
export const CLAUDE_CODE_SESSION_END_TIMEOUT_MS = 700;
/** Dispatch time kept free after Git metadata for the local queue write. */
const CAPTURE_QUEUE_RESERVE_MS = 250;
export function isSessionEndEvent(event) {
    return event === 'SessionEnd' || event === 'sessionEnd' || event === 'session_end';
}
/**
 * Dispatch budget for one hook event; the runtime process deadline adds input
 * headroom on top. Only SessionEnd depends on the host.
 */
export function hookDispatchTimeoutMs(event, host) {
    if (isSessionEndEvent(event))
        return host === 'claude-code' ? CLAUDE_CODE_SESSION_END_TIMEOUT_MS : SESSION_END_TIMEOUT_MS;
    if (isSessionStartEvent(event))
        return SESSION_START_TIMEOUT_MS;
    return DEFAULT_EVENT_TIMEOUT_MS;
}
/**
 * Longest a dispatch may run. Only a SessionStart token refresh moves the
 * deadline past `hookDispatchTimeoutMs`, and never past this cap.
 */
export function hookDispatchMaxTimeoutMs(event, host) {
    return isSessionStartEvent(event) ? SESSION_START_MAX_TIMEOUT_MS : hookDispatchTimeoutMs(event, host);
}
function editedPathFromEvent(event) {
    if (!event.cwd || !event.toolInput || typeof event.toolInput !== 'object')
        return undefined;
    const input = event.toolInput;
    const candidate = [input.file_path, input.filePath, input.path].find((value) => typeof value === 'string' && value.trim().length > 0);
    return candidate ? filterRelativePaths([candidate], event.cwd)[0] : undefined;
}
/**
 * Host and Brain tools that only read. Claude Code built-ins, plus the Brain
 * tools apps/mcp annotates `readOnlyHint` and `brain_digest_pending`, which
 * only claims digests for the proposals that follow.
 */
const READ_ONLY_TOOL_NAMES = new Set([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'WebFetch',
    'WebSearch',
    'NotebookRead',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'BashOutput',
    'brain_workspaces_list',
    'brain_workspace_overview',
    'brain_graph_read',
    'brain_node_read',
    'brain_file_read',
    'brain_node_search',
    'brain_context_handoff',
    'brain_tags_list',
    'brain_comment_list',
    'brain_workflow_due',
    'brain_skill_resolve',
    'brain_paste',
    'brain_digest_pending',
]);
const READ_VERBS = new Set([
    'read', 'list', 'get', 'search', 'find', 'fetch', 'query', 'view', 'grep', 'glob', 'ls', 'overview',
    'show', 'describe', 'resolve', 'due', 'pending', 'lookup', 'inspect', 'browse', 'preview', 'retrieve', 'count',
]);
const WRITE_VERBS = new Set([
    'create', 'update', 'delete', 'remove', 'write', 'edit', 'add', 'set', 'post', 'send', 'mark', 'apply', 'run',
    'save', 'publish', 'insert', 'move', 'rename', 'upload', 'reply', 'merge', 'close', 'archive', 'replace', 'put',
    'patch', 'push', 'commit', 'change', 'modify', 'append', 'upsert', 'clear', 'reset', 'sync', 'import', 'export',
    'copy', 'share', 'pin', 'star', 'subscribe', 'unsubscribe', 'invite', 'assign', 'approve', 'reject', 'submit',
    'schedule', 'cancel', 'start', 'stop', 'restart', 'deploy', 'execute', 'exec', 'trigger', 'install', 'uninstall',
    'enable', 'disable', 'toggle', 'record', 'complete', 'propose', 'remember', 'amend', 'revert', 'kill',
    'transfer', 'grant', 'revoke', 'lock', 'unlock', 'fork', 'clone',
]);
const VERB_CONJUNCTIONS = new Set(['and', 'or', 'then']);
/** Lowercase words of a tool name, split at separators and camelCase or acronym boundaries. */
function toolNameTokens(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}
/**
 * Whether a tool call only reads, so it does not make a session slice worth
 * capturing. Words, not substrings, decide (`update_spreadsheet` and
 * `mark_as_read` write; `Grep` and `get_file_contents` read). After the exact
 * list, the first verb in the name decides; a verb directly after it or joined
 * by and/or/then forms a compound with it (`search_replace`,
 * `find_and_replace`), and any write verb in the compound wins. A name with no
 * known verb is not read-only.
 */
export function isReadOnlyToolName(name) {
    const bare = name.replace(/^mcp__.+?__/, '');
    if (READ_ONLY_TOOL_NAMES.has(bare))
        return true;
    const tokens = toolNameTokens(bare);
    const isVerb = (token) => token !== undefined && (READ_VERBS.has(token) || WRITE_VERBS.has(token));
    let index = tokens.findIndex(isVerb);
    if (index < 0)
        return false;
    while (index < tokens.length) {
        if (WRITE_VERBS.has(tokens[index]))
            return false;
        const next = VERB_CONJUNCTIONS.has(tokens[index + 1] ?? '') ? index + 2 : index + 1;
        if (!isVerb(tokens[next]))
            break;
        index = next;
    }
    return true;
}
/**
 * A path-free failure class for diagnostics: a Node error code (`ENOENT`), the
 * deadline, or the error's class name. Messages can name absolute project
 * paths and stay out of the log.
 */
function dispatchFailureClass(error, timedOut) {
    const code = error?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code))
        return code;
    if (timedOut)
        return 'timeout';
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name))
        return error.name;
    return 'unknown';
}
/**
 * Whether a hook `init` wrote should stand aside for the host's BrainMCP
 * plugin: only when the host will run the plugin's own hook for this event.
 * Only Claude Code and Codex plugins ship hooks, none ships the Stop nudge, and
 * Codex skips plugin hooks the user has not trusted ("Continue without
 * trusting"). A plugin's own hooks (`fromPlugin`) never yield. Reading host
 * plugin state is a few small local files, and any read failure keeps the
 * managed hook running.
 */
export function managedHookYieldsToPlugin(event, lookup) {
    const host = event.client;
    if (event.fromPlugin || !isPluginHost(host))
        return false;
    const roots = event.workspaceRoots?.length ? event.workspaceRoots : [event.cwd];
    try {
        return roots.some((root) => {
            const active = detectHostPlugin(host, { ...lookup, root }).active;
            return active !== undefined && pluginRunsHook(host, active, event.event);
        });
    }
    catch {
        return false;
    }
}
/**
 * Strict bounded stdin reader with length check.
 */
export async function readBoundedStdin(stream = process.stdin, maxBytes = MAX_STDIN_BYTES, signal) {
    return new Promise((resolve, reject) => {
        let totalBytes = 0;
        const chunks = [];
        let settled = false;
        const cleanup = () => {
            stream.removeListener('data', data);
            stream.removeListener('end', end);
            stream.removeListener('error', fail);
            signal?.removeEventListener('abort', abort);
            stream.pause();
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(err);
        };
        const abort = () => fail(new Error('Hook input timed out'));
        const data = (chunk) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            totalBytes += buf.length;
            if (totalBytes > maxBytes) {
                fail(new Error(`Input exceeded maximum size limit of ${maxBytes} bytes`));
                return;
            }
            chunks.push(buf);
        };
        const end = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        stream.on('data', data);
        stream.on('end', end);
        stream.on('error', fail);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted)
            abort();
    });
}
/**
 * The closing replies of the latest turns in the host's transcript, or
 * undefined. Logs only why it found none (a content-free class).
 */
function hostTranscriptSummary(event, baseDir) {
    let result;
    try {
        result = readTranscriptSummary(event.transcriptPath);
    }
    catch {
        result = { failure: 'read_error' };
    }
    if ('summary' in result)
        return result.summary;
    logRuntimeEvent('info', 'capture_transcript_summary_unavailable', { event: event.event, client: event.client, reason: result.failure }, baseDir);
    return undefined;
}
/** A plugin's SessionStart also carries the always-on guidance it cannot install as a file. */
function pluginContext(event, context, lookup) {
    const roots = event.workspaceRoots?.length ? event.workspaceRoots : event.cwd ? [event.cwd] : [];
    return pluginSessionStartContext(context, { host: event.client, roots, lookup });
}
function hostOutput(event, additionalContext) {
    try {
        return emitHostOutput(event.client, event, additionalContext);
    }
    catch {
        return {};
    }
}
async function loadRuntimeClient(options) {
    if (options?.apiClient) {
        return {
            apiClient: options.apiClient,
            creds: options.credentials === undefined ? await options.apiClient.getEffectiveCredentials() : options.credentials,
        };
    }
    try {
        const { store } = await createDefaultCredentialStore({
            baseDir: options?.baseDir,
            warn: () => undefined,
        });
        const apiClient = new ApiClient({ store });
        return { apiClient, creds: await apiClient.getEffectiveCredentials() };
    }
    catch {
        return { apiClient: null, creds: null };
    }
}
/**
 * Dispatches a normalized HookEvent under deadline/abort control (AHI-053).
 * Always fails open with empty success on error or timeout.
 *
 * Stop/SessionStop never queues or flushes digests (AHI-D03).
 * Capture queue writes require user-local consent (AHI-D01) and are further
 * restrictable by project `.brainmcp.json` (AHI-D02).
 */
export async function dispatchHookEvent(event, options) {
    const timeoutMs = options?.timeoutMs ?? hookDispatchTimeoutMs(event.event, event.client);
    const maxTimeoutMs = Math.max(timeoutMs, options?.maxTimeoutMs
        ?? (options?.timeoutMs === undefined ? hookDispatchMaxTimeoutMs(event.event, event.client) : timeoutMs));
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options?.signal?.aborted)
        controller.abort();
    const startedAt = Date.now();
    let deadlineAt = startedAt + timeoutMs;
    let timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // Orientation calls this before a token refresh so the refresh and its
    // requests share the longer budget; the abort timer moves with the deadline,
    // up to the cap.
    const extendDeadline = (requested) => {
        const next = Math.min(requested, startedAt + maxTimeoutMs);
        if (next > deadlineAt && !controller.signal.aborted) {
            deadlineAt = next;
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort(), next - Date.now());
        }
        return deadlineAt;
    };
    // Keep credential lookup rooted at the Brain home; the pinned account
    // directory below is only for this event's local state.
    const credentialOptions = options;
    try {
        // An enabled BrainMCP plugin ships these same hooks. A hook that `init`
        // wrote then does nothing, so the plugin's copy runs alone. A nudge-ledger
        // hook decides below, once the capture policy is known.
        const yieldsToPlugin = managedHookYieldsToPlugin(event, options?.pluginLookup);
        if (yieldsToPlugin && !event.nudgeLedger) {
            return { handled: true, emptyFallback: false, outputPayload: {} };
        }
        // Never persist host IDs or share ledgers across hosts/projects. A missing
        // session ID permits orientation only, never a shared fallback ledger.
        if ((!event.sessionKey || event.sessionKey === 'default_session') && !isSessionStartEvent(event.event)) {
            return { handled: false, emptyFallback: true, outputPayload: {} };
        }
        event = { ...event, sessionKey: crypto.createHash('sha256').update(JSON.stringify([
                event.client, event.sessionKey, event.workspaceRoots?.length ? [...event.workspaceRoots].sort() : [event.cwd ?? ''],
            ])).digest('hex') };
        options = { ...options, baseDir: resolveStateDir(options?.baseDir) };
        if (controller.signal.aborted) {
            throw new Error('Hook dispatch timed out');
        }
        const prefs = readPreferences(options?.baseDir);
        const roots = event.workspaceRoots?.length ? event.workspaceRoots : event.cwd ? [event.cwd] : [];
        const policies = roots.map(readProjectCaptureRestrictions);
        const projectPolicy = {
            captureDisabled: policies.some((policy) => policy.captureDisabled) || projectBindingBlocksCapture(roots, prefs?.enabledWorkspaceId),
            promptsDisabled: policies.some((policy) => policy.promptsDisabled),
        };
        // Consent to an earlier capture policy pauses capture (doctor says how to re-consent).
        const captureRuntimeEnabled = Boolean(captureConsentActive(prefs) && !projectPolicy.captureDisabled);
        // Content needs the complete capture policy: a project opt-out stops prompt
        // text too, so a nudge ledger recorded under it stays content-free and a
        // later re-enable in the same session cannot send what was typed meanwhile.
        const persistPrompts = Boolean(captureRuntimeEnabled &&
            prefs?.consent?.includePrompts &&
            !projectPolicy.promptsDisabled);
        // With capture on, the plugin's own hook records this event in the session
        // ledger, content included, so a nudge-ledger hook stands aside. With capture
        // off the plugin's hook records nothing, and this hook keeps the content-free
        // counters the write-back nudge reads (no plugin ships the nudge).
        if (yieldsToPlugin && captureRuntimeEnabled) {
            return { handled: true, emptyFallback: false, outputPayload: {} };
        }
        // Stop is a hard zero-persistence and zero-egress boundary. StopNudge is a
        // separate, explicitly installed command and only reads bounded local state.
        if (event.event !== 'StopNudge' && isStopEvent(event.event, event.stopHookActive)) {
            logRuntimeEvent('info', 'hook_stop_ignored', { event: event.event, sessionKey: event.sessionKey, client: event.client }, options?.baseDir);
            return {
                handled: true,
                emptyFallback: false,
                outputPayload: hostOutput(event),
            };
        }
        // Init installs dormant lifecycle boundaries so a later capture opt-in can
        // work without rewriting every host config. Until then they persist no
        // prompt, tool, path, summary, or session ledger data. The nudge ledger is
        // separately tagged in the managed command and never enables capture.
        if (!isSessionStartEvent(event.event) &&
            !captureRuntimeEnabled &&
            !event.nudgeLedger &&
            event.event !== 'StopNudge') {
            return {
                handled: true,
                emptyFallback: false,
                outputPayload: hostOutput(event),
            };
        }
        // Orientation-only SessionStart must not create a session ledger before
        // capture consent. It may read or refresh the authorization-scoped orient
        // cache, but it stores no session, prompt, tool, path, or summary record.
        if (isSessionStartEvent(event.event) && !captureRuntimeEnabled && !event.nudgeLedger) {
            const { apiClient, creds } = await withRequestDeadline(timeoutMs, controller.signal, () => loadRuntimeClient(credentialOptions));
            const additionalContext = apiClient
                ? await safeSessionStartOrientation({
                    apiClient,
                    creds,
                    signal: controller.signal,
                    deadlineAt,
                    extendDeadline,
                    baseDir: options?.baseDir,
                    cwd: event.cwd,
                    workspaceRoots: event.workspaceRoots,
                    loginCommand: options?.loginCommand,
                })
                : loginOrientationMessage(options?.loginCommand);
            if (controller.signal.aborted)
                throw new Error('Hook dispatch timed out');
            return {
                handled: true,
                emptyFallback: false,
                outputPayload: hostOutput(event, event.fromPlugin ? pluginContext(event, additionalContext, options?.pluginLookup) : additionalContext),
            };
        }
        const isMeaningful = Boolean(event.prompt ||
            event.assistantText ||
            event.event === 'UserPrompt' ||
            event.event === 'prompt' ||
            (event.toolName && !isReadOnlyToolName(event.toolName)));
        // Claude Code and Codex hooks carry no assistant text, so at a capture
        // boundary the host's own transcript supplies the turns' closing replies.
        const transcriptSummary = captureRuntimeEnabled && captureTriggerForEvent(event.event) && event.transcriptPath
            ? hostTranscriptSummary(event, options.baseDir)
            : undefined;
        // options.baseDir is the account state directory by now; backups live in the brain home.
        if (isSessionStartEvent(event.event))
            pruneLocalState({ baseDir: options.baseDir, brainHome: credentialOptions?.baseDir ?? getBrainHome() });
        const ledger = await recordSessionEvent({
            sessionKey: event.sessionKey,
            baseDir: options?.baseDir,
            isMeaningful,
            editedPath: captureRuntimeEnabled ? editedPathFromEvent(event) : undefined,
            prompt: persistPrompts ? event.prompt : undefined,
            assistantSummary: captureRuntimeEnabled ? event.assistantText ?? transcriptSummary : undefined,
            model: captureRuntimeEnabled ? event.model : undefined,
            persistPrompts,
            captureRevision: captureRuntimeEnabled ? prefs?.consent.revision ?? 0 : undefined,
            workspaceId: captureRuntimeEnabled ? prefs?.enabledWorkspaceId : undefined,
            // A deleted cwd yields no key, so the ledger keeps the one it recorded
            // while the directory existed.
            projectKey: event.cwd ? tryCaptureProjectKey(event.cwd) : undefined,
            toolResult: event.toolName
                ? {
                    toolName: event.toolName,
                    result: event.toolResult,
                }
                : undefined,
        }).catch((error) => {
            // SessionStart orientation needs no ledger: a busy session lock or a
            // failed write must not cost the agent its Brain context.
            if (!isSessionStartEvent(event.event))
                throw error;
            logRuntimeEvent('warn', 'session_ledger_write_failed', {
                event: event.event,
                sessionKey: event.sessionKey,
                error: dispatchFailureClass(error, controller.signal.aborted),
            }, options?.baseDir);
            return null;
        });
        if (controller.signal.aborted) {
            throw new Error('Hook dispatch timed out');
        }
        if (event.event === 'StopNudge' && ledger) {
            const lastMeaningful = ledger.lastMeaningfulSequence ?? 0;
            const alreadyHandledThrough = Math.max(ledger.lastSuccessfulWriteBackSequence ?? 0, ledger.lastNudgedSequence ?? 0);
            if (!event.stopHookActive && lastMeaningful > alreadyHandledThrough) {
                await markSessionNudged({
                    sessionKey: event.sessionKey,
                    nudgedThroughSequence: lastMeaningful,
                    baseDir: options?.baseDir,
                });
                return {
                    handled: true,
                    emptyFallback: false,
                    outputPayload: hostOutput(event, 'Before finishing, consider whether this work produced genuinely new durable project knowledge. If so, use brain_remember, brain_amend, or brain_change_propose; otherwise continue without writing.'),
                };
            }
            return { handled: true, emptyFallback: false, outputPayload: {} };
        }
        // Defensive invariant for any future stop alias added after the early gate.
        if (isStopEvent(event.event, event.stopHookActive)) {
            logRuntimeEvent('info', 'hook_stop_ignored', {
                event: event.event,
                sessionKey: event.sessionKey,
                client: event.client,
            }, options?.baseDir);
            return {
                handled: true,
                emptyFallback: false,
                outputPayload: hostOutput(event),
            };
        }
        const { apiClient, creds } = await withRequestDeadline(timeoutMs, controller.signal, () => loadRuntimeClient(credentialOptions));
        let additionalContext;
        if (isSessionStartEvent(event.event)) {
            additionalContext = apiClient
                ? await safeSessionStartOrientation({
                    apiClient,
                    creds,
                    signal: controller.signal,
                    deadlineAt,
                    extendDeadline,
                    baseDir: options?.baseDir,
                    cwd: event.cwd,
                    workspaceRoots: event.workspaceRoots,
                    loginCommand: options?.loginCommand,
                })
                : loginOrientationMessage(options?.loginCommand);
            if (event.fromPlugin)
                additionalContext = pluginContext(event, additionalContext, options?.pluginLookup);
        }
        else if (isUserPromptEvent(event.event)) {
            // AHI-D18: never transmit prompt text as an /orient query.
            additionalContext = undefined;
        }
        if (controller.signal.aborted) {
            throw new Error('Hook dispatch timed out');
        }
        const trigger = captureTriggerForEvent(event.event);
        const hasUncapturedMeaningfulSlice = ledger !== null && (ledger.lastMeaningfulSequence ?? 0) > (ledger.lastCapturedSequence ?? 0);
        if (trigger &&
            isCaptureEligible(event.event, prefs, projectPolicy) &&
            hasUncapturedMeaningfulSlice) {
            const workspaceId = resolveCaptureWorkspaceId(prefs);
            const projectRoots = queueProjectRoots(roots);
            if (!workspaceId) {
                logRuntimeEvent('warn', 'capture_workspace_unresolved', {
                    event: event.event,
                    sessionKey: event.sessionKey,
                }, options?.baseDir);
            }
            else if (!projectRoots) {
                // Every root's policy is rechecked at send time, so a root the queue
                // item cannot record must not be captured at all.
                logRuntimeEvent('warn', 'capture_project_roots_unrecordable', { event: event.event, sessionKey: event.sessionKey, roots: roots.length }, options?.baseDir);
            }
            else if (!canEnqueueCapture(options?.baseDir)) {
                logRuntimeEvent('warn', 'capture_queue_capped', { event: event.event, sessionKey: event.sessionKey }, options?.baseDir);
            }
            else {
                if (creds?.authType !== 'oauth' ||
                    !creds.authorizationId ||
                    !creds.scopes?.includes('digests:write') ||
                    !creds.workspaces?.includes(workspaceId)) {
                    logRuntimeEvent('warn', 'capture_authorization_unresolved', { event: event.event, sessionKey: event.sessionKey }, options?.baseDir);
                }
                else {
                    // A host with a transcript summarizes each slice from it; when that read
                    // fails, the ledger's summary belongs to an earlier slice and is not resent.
                    const summary = event.transcriptPath ? transcriptSummary : ledger.assistantSummary;
                    const includePrompts = Boolean(prefs?.consent?.includePrompts && !projectPolicy.promptsDisabled);
                    if (!summary?.trim() && !(includePrompts && ledger.prompts?.length)) {
                        // Paths and Git counts alone hold nothing to process, and such digests
                        // filled the workspace's pending-digest cap (2026-10-15). The slice
                        // stays uncaptured, so a later boundary can still send it.
                        logRuntimeEvent('info', 'capture_skipped_no_summary', { event: event.event, sessionKey: event.sessionKey, client: event.client }, options?.baseDir);
                    }
                    else {
                        const payload = buildDigestPayload({
                            trigger,
                            workspaceId,
                            host: event.client,
                            model: event.model ?? ledger.model,
                            summary,
                            paths: ledger.editedPaths,
                            gitMetadata: collectGitMetadata(event.cwd ?? event.workspaceRoots?.[0], {
                                trigger,
                                deadlineAt: deadlineAt - CAPTURE_QUEUE_RESERVE_MS,
                                baseDir: options?.baseDir,
                            }),
                            prompts: ledger.prompts,
                            includePrompts,
                        });
                        const queued = await queueSessionCapture({
                            sessionKey: event.sessionKey,
                            capturedThroughSequence: ledger.lastMeaningfulSequence ?? ledger.eventSequence,
                            baseDir: options?.baseDir,
                            item: {
                                digestId: payload.clientDigestId,
                                workspaceId,
                                captureTrigger: trigger,
                                policyVersion: prefs?.consent?.policyVersion ?? CAPTURE_POLICY_VERSION,
                                digestText: serializeDigestPayload(payload),
                                authorizationId: creds.authorizationId,
                                consentRevision: prefs?.consent?.revision ?? 0,
                                projectRoots,
                            },
                        });
                        // Log the slice's derived queue ID, and only when this slice has an item.
                        // A slice another hook already reserved needs no entry.
                        if (queued.kind === 'queued' || queued.kind === 'existing') {
                            logRuntimeEvent('info', 'capture_queued', {
                                sessionKey: event.sessionKey,
                                digestId: queued.item.digestId,
                                trigger,
                                ...(queued.kind === 'existing' ? { existing: true } : {}),
                            }, options?.baseDir);
                        }
                        else if (queued.kind === 'queue_full') {
                            logRuntimeEvent('warn', 'capture_queue_capped', { event: event.event, sessionKey: event.sessionKey }, options?.baseDir);
                        }
                    }
                }
            }
        }
        const canFlush = Boolean(apiClient) &&
            creds?.authType === 'oauth' &&
            Boolean(creds.accessToken) &&
            Boolean(creds.authorizationId) &&
            Array.isArray(creds.scopes) &&
            creds.scopes.includes('digests:write');
        // A digest POST does not fit a hook's budget, so hooks never send: they
        // start a detached process that delivers after this hook returns.
        const allowAutomatic = captureConsentActive(prefs) && !projectPolicy.captureDisabled;
        if (canFlush && allowAutomatic && options?.startBackgroundFlush && !controller.signal.aborted) {
            await options.startBackgroundFlush({ baseDir: options.baseDir }).catch((error) => {
                logRuntimeEvent('warn', 'capture_background_flush_start_failed', { event: event.event, error: dispatchFailureClass(error, controller.signal.aborted) }, options?.baseDir);
                return false;
            });
        }
        logRuntimeEvent('info', 'hook_event_processed', {
            event: event.event,
            sessionKey: event.sessionKey,
            client: event.client,
        }, options?.baseDir);
        return {
            handled: true,
            emptyFallback: false,
            outputPayload: hostOutput(event, additionalContext),
        };
    }
    catch (err) {
        logRuntimeEvent('warn', 'hook_dispatch_failed', {
            event: event.event,
            sessionKey: event.sessionKey,
            error: dispatchFailureClass(err, controller.signal.aborted),
        }, options?.baseDir);
        return {
            handled: false,
            emptyFallback: true,
            outputPayload: {},
            error: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onExternalAbort);
    }
}
//# sourceMappingURL=hook-dispatcher.js.map