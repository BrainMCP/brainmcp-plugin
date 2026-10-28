import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE_INFERENCE_GUIDANCE } from '../agent-config.js';
import { apiPathSegment } from '../api-client.js';
import { accessTokenExpiresSoon, CompanionReauthRequiredError } from '../lib/api-client.js';
import { OAuthRefreshFailedError } from '../lib/oauth-client.js';
import { COMPANION_WORKSPACES_PATH } from '../lib/endpoints.js';
import { isWorkspaceUuid, normalizeWorkspaceId } from '../lib/cli-contracts.js';
import { resolveStateDir } from './storage.js';
import { logRuntimeEvent } from './diagnostics.js';
export const ORIENT_CONTEXT_MAX_CHARS = 2_700;
/** `mustSurfaceToUser` actions shown in the hook packet, one bounded line each. */
const ORIENT_MAX_SURFACED_ACTIONS = 3;
const ORIENT_SURFACED_ACTION_MAX_CHARS = 240;
/**
 * SessionStart budget shared by credential loading, the optional workspace
 * listing, and the orient requests. A fixed 800 ms per request inside a 1 s
 * deadline failed about half of warm starts against the us-east-1 API from
 * distant edges, and 2.5 s still missed most first requests after a minute
 * idle: a cold placed API isolate answered `/orient` in 1.6–5.4 s (measured
 * 2026-10-02). Warm requests finish in well under 1 s, so only cold starts wait.
 */
export const SESSION_START_TIMEOUT_MS = 4_000;
/**
 * Hard cap for a SessionStart that must refresh its access token first. Access
 * tokens last about an hour, so most first sessions after a break refresh. On
 * 2026-10-12 (Tbilisi) CLI 0.1.33 spent 2.0 s refreshing and `/orient` was
 * aborted with the 1.5 s left; `/orient` alone took 1.1–2.5 s and sometimes
 * over 3.6 s. CLI 0.1.34 extended the deadline only after the refresh, so a
 * 3.9 s refresh still timed out on its own. The refresh and the requests now
 * share this cap. Sessions that need no refresh keep SESSION_START_TIMEOUT_MS.
 */
export const SESSION_START_MAX_TIMEOUT_MS = 2 * SESSION_START_TIMEOUT_MS;
/**
 * Requests stop this long before the caller's deadline so a timed-out
 * orientation is reported to the agent instead of being dropped as `{}`.
 */
export const SESSION_START_REPORT_MARGIN_MS = 300;
export const SESSION_START_EVENTS = new Set([
    'SessionStart',
    'sessionStart',
    'session_start',
    'startup',
]);
export function isSessionStartEvent(event) {
    return SESSION_START_EVENTS.has(event);
}
export function isUserPromptEvent(event) {
    return event === 'UserPromptSubmit' || event === 'UserPrompt' || event === 'prompt' || event === 'beforeSubmitPrompt';
}
export function resolveOrientWorkspaceId(creds, listing) {
    if (!creds || creds.authType !== 'oauth' || !creds.accessToken) {
        return { workspaceId: null, reason: 'login' };
    }
    if (creds.defaultWorkspaceId && isWorkspaceUuid(creds.defaultWorkspaceId)) {
        return { workspaceId: creds.defaultWorkspaceId, reason: 'ok' };
    }
    const fromCreds = (creds.workspaces ?? []).filter((id) => isWorkspaceUuid(id));
    if (fromCreds.length === 1) {
        return { workspaceId: fromCreds[0], reason: 'ok' };
    }
    if (listing) {
        const listed = Array.isArray(listing.workspaces) ? listing.workspaces : [];
        const listedIds = [...new Set(listed
                .map((ws) => ws?.id)
                .filter((id) => typeof id === 'string' && isWorkspaceUuid(id)))];
        // The grant default counts only while the token can still reach it.
        const accountDefault = listing.account?.defaultWorkspaceId;
        if (typeof accountDefault === 'string' && listedIds.includes(accountDefault)) {
            return { workspaceId: accountDefault, reason: 'ok' };
        }
        const marked = [...new Set(listed
                .filter((ws) => ws?.isDefault === true && listedIds.includes(ws.id))
                .map((ws) => ws.id))];
        if (marked.length === 1)
            return { workspaceId: marked[0], reason: 'ok' };
        if (listedIds.length === 1)
            return { workspaceId: listedIds[0], reason: 'ok' };
    }
    return { workspaceId: null, reason: 'select' };
}
const ORIENT_PACKET_FIRST_LINE = 'BrainMCP orientation (no user prompt was sent).';
/**
 * The packet always arrives beside Brain's always-on guidance (init's managed block, or the
 * plugin's compact block in the same hook string), which already covers answer grounding and
 * write-back. Repeating them here used most of the budget, so the packet carries workspace details.
 */
const ORIENT_PACKET_HEADER = [
    ORIENT_PACKET_FIRST_LINE,
    'Workspace details only; the Brain guidance covers grounding and saving. This packet is bounded: call brain_workspace_overview for full Rules and current context before dependent work. Clipped or omitted details are incomplete.',
].join('\n');
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function clipContext(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    // Avoid splitting a UTF-16 surrogate pair at the packet or excerpt boundary.
    return `${text.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}
/** Rule bodies (local and parent together) the hook packet shows in full or as excerpts. */
const ORIENT_MAX_RULE_BODIES = 5;
const ORIENT_RULE_BODY_MAX_CHARS = 400;
function ruleLine(label, rawBody) {
    const body = rawBody.trim();
    return body.length > ORIENT_RULE_BODY_MAX_CHARS
        ? `${label} excerpt (incomplete): ${clipContext(body, ORIENT_RULE_BODY_MAX_CHARS + 1)}`
        : `${label}: ${body}`;
}
const PARENT_STATUS_TEXT = {
    available: 'available, read-only',
    needs_approval: 'needs approval for this connection',
    // The API answers every CLI companion with no_access: the companion itself never reads parent context.
    no_access: 'not read by this companion',
    paid_plan_required: 'paused until the paid plan is renewed',
    unavailable: 'unavailable',
    feature_unavailable: 'shared context is turned off',
};
/**
 * The overview's `parentContext` block (only for a workspace with an attached parent): one
 * summary line, plus the parent's always-on Rule bodies for the shared Rule bound.
 */
function readParentContext(value) {
    if (!isRecord(value) || typeof value.status !== 'string')
        return undefined;
    const name = typeof value.name === 'string' && value.name.trim() ? `"${clipContext(value.name.trim(), 80)}"` : 'a parent workspace';
    const statusText = PARENT_STATUS_TEXT[value.status] ?? 'status unknown';
    const listed = Array.isArray(value.rules) ? value.rules : [];
    const rules = listed.filter((rule) => isRecord(rule) && typeof rule.body === 'string' && Boolean(rule.body.trim())).map((rule) => rule.body);
    const parts = [`Parent context: this workspace inherits from ${name} (${statusText}).`];
    // A complete page says so; a page with more Rules, or with bodies left out, is never "all of them".
    const page = isRecord(value.rulesPage) ? value.rulesPage : undefined;
    const pageIncomplete = page?.complete === false || page?.hasMore === true;
    if (value.status === 'available') {
        const total = typeof page?.totalCount === 'number' && page.totalCount > rules.length ? page.totalCount : undefined;
        parts.push(pageIncomplete || rules.length !== listed.length
            ? `Parent Rules are incomplete here (${rules.length} listed${total ? ` of ${total}` : ''}): follow the listed ones like this workspace's Rules and read the rest through brain_workspace_overview parentContext (rulesPage.continuation, bodyRead) before Rule-dependent work.`
            : rules.length
                ? `${rules.length} parent Rule${rules.length === 1 ? '' : 's'} apply: follow them like this workspace's Rules.`
                : 'No parent Rules apply.');
        parts.push('Write only to this workspace, never to the parent.');
    }
    else if (value.status === 'no_access') {
        // The companion's own refusal, not the person's access: its fix would only repeat this line.
        parts.push('The CLI companion never reads parent context, so parent Rules and knowledge are not in this packet. Agents connected over MCP read them once that connection is approved for the parent: check the host\'s brain_workspace_overview parentContext.');
    }
    else {
        parts.push(value.status === 'paid_plan_required'
            ? 'Parent Rules and knowledge were not loaded; do not retry through another tool.'
            : 'Parent Rules and knowledge were not loaded for this companion connection; the host connection may differ, so check host brain_workspace_overview.');
        const fix = isRecord(value.fix) && typeof value.fix.message === 'string' && value.fix.message.trim() ? value.fix : undefined;
        if (fix) {
            const where = typeof fix.dashboardPath === 'string' && fix.dashboardPath.startsWith('/') ? ` (dashboard: ${clipContext(fix.dashboardPath, 120)})` : '';
            parts.push(`Fix: ${clipContext(String(fix.message).trim(), ORIENT_SURFACED_ACTION_MAX_CHARS)}${where}`);
        }
    }
    return { summary: parts.join(' ').replace(/\s+/g, ' '), rules,
        incomplete: rules.length !== listed.length || (value.status === 'available' && pageIncomplete) };
}
function formatOrientDetails(payload, expectedWorkspaceId) {
    const workspace = isRecord(payload) && isRecord(payload.workspace) ? payload.workspace : undefined;
    if (!workspace || typeof workspace.id !== 'string' || !workspace.id.trim()
        || typeof workspace.name !== 'string' || !workspace.name.trim()
        || (expectedWorkspaceId && workspace.id !== expectedWorkspaceId)) {
        return `${expectedWorkspaceId ? `Workspace ${expectedWorkspaceId}: ` : ''}BrainMCP orientation returned no usable context. Call brain_workspace_overview for this workspace before dependent work.`;
    }
    const data = payload;
    const lines = [`Workspace ${clipContext(workspace.id, 80)}: ${clipContext(workspace.name.trim(), 120)}`];
    const authorization = isRecord(data.authorization) ? data.authorization : undefined;
    const scopes = Array.isArray(authorization?.scopes) && authorization.scopes.every((scope) => typeof scope === 'string')
        ? authorization.scopes : undefined;
    const canWrite = scopes?.some((scope) => scope === '*' || scope === 'changes:write') === true;
    if (!canWrite) {
        lines.push(scopes
            ? 'Companion authorization lacks changes:write. Host MCP permissions are independent; check its overview before proposing changes.'
            : 'Companion write access is unknown. Check host MCP permissions in overview before proposing changes.');
    }
    const review = isRecord(data.review) ? data.review : undefined;
    if (canWrite && typeof review?.writePath === 'string') {
        lines.push(`Write path: ${clipContext(review.writePath, 80)}`);
    }
    // `review.policyStatus` is optional; older servers omit it. When the policy
    // read failed, `humanReviewRequired` is only the server's fallback value.
    if (review?.policyStatus === 'unavailable') {
        lines.push('Review policy could not be loaded; do not assume writes need review or that they auto-apply. Retry brain_workspace_overview before writing.');
    }
    else if (review?.humanReviewRequired === true) {
        lines.push('Human review is required before graph writes apply.');
    }
    const actions = Array.isArray(data.recommendedNextActions) ? data.recommendedNextActions : [];
    for (const action of actions.filter((entry) => isRecord(entry) && entry.mustSurfaceToUser === true && typeof entry.title === 'string' && Boolean(entry.title.trim()))
        .slice(0, ORIENT_MAX_SURFACED_ACTIONS)) {
        const reason = typeof action.reason === 'string' ? action.reason : '';
        const line = `Tell the user: ${action.title.trim()}${reason.trim() ? ` (${reason.trim()})` : ''}`.replace(/\s+/g, ' ');
        lines.push(clipContext(line, ORIENT_SURFACED_ACTION_MAX_CHARS));
    }
    for (const [field, label] of [['pendingProposalCount', 'Pending proposals'], ['dueWorkflowCount', 'Due workflows']]) {
        const count = data[field];
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
            lines.push(`${label}: ${count}`);
    }
    const rules = isRecord(data.rules) ? data.rules : undefined;
    const items = Array.isArray(rules?.items) ? rules.items : [];
    const validRules = items.filter((rule) => isRecord(rule) && typeof rule.body === 'string' && Boolean(rule.body.trim()));
    const responseCap = isRecord(data.responseCap) ? data.responseCap : undefined;
    const parent = readParentContext(data.parentContext);
    // `rules.status` is optional ('ok' | 'unavailable'); older servers omit it. An
    // unavailable Rule set is never an empty one, even with zero items.
    const rulesUnavailable = rules?.status === 'unavailable';
    if (rulesUnavailable) {
        lines.push('Brain Rules could not be loaded; do not assume this workspace has no Rules. Retry brain_workspace_overview before dependent work.');
    }
    // Local and parent Rule bodies share one bound, local first.
    if (!rules || !Array.isArray(rules.items) || validRules.length !== items.length
        || items.length + (parent?.rules.length ?? 0) > ORIENT_MAX_RULE_BODIES || rules.truncated === true || rulesUnavailable
        || (Array.isArray(rules.omittedRules) && rules.omittedRules.length > 0)
        || parent?.incomplete === true
        || responseCap?.applied === true) {
        lines.push('Rules or other context are incomplete; recover omitted content through brain_workspace_overview and exact reads.');
    }
    for (const rule of validRules.slice(0, ORIENT_MAX_RULE_BODIES))
        lines.push(ruleLine('Rule', rule.body));
    if (parent) {
        lines.push(parent.summary);
        for (const body of parent.rules.slice(0, Math.max(0, ORIENT_MAX_RULE_BODIES - validRules.length)))
            lines.push(ruleLine('Parent Rule', body));
    }
    return lines.join('\n');
}
/**
 * A child whose organization lost the paid plan its agents need: the API refuses agent reads of
 * both the child and its parent. That is not an empty workspace or a request to sign in again.
 */
function paidPlanOrientation(error, workspaceId) {
    if (!isRecord(error) || error.status !== 403 || error.code !== 'workspace_inheritance_paid_plan_required')
        return undefined;
    return `Workspace ${workspaceId}: agent access is paused because the organization that owns this workspace no longer has the paid plan its agents need. No workspace or parent knowledge was loaded. Do not retry through another tool; tell the user the owner can renew from the dashboard.`;
}
export function formatOrientAdditionalContext(payload) {
    return clipContext(`${ORIENT_PACKET_HEADER}\n${formatOrientDetails(payload)}`, ORIENT_CONTEXT_MAX_CHARS);
}
/**
 * The command a user runs to start a companion sign-in. A plugin install has no
 * `brainmcp` on PATH, so its hooks pass the vendored CLI's own command instead.
 */
export const DEFAULT_COMPANION_LOGIN_COMMAND = 'brainmcp login';
export function loginOrientationMessage(loginCommand = DEFAULT_COMPANION_LOGIN_COMMAND) {
    return `BrainMCP CLI is not signed in. No remote request was made. Host MCP access is independent: use the host brain_* tools to orient if connected. Run \`${loginCommand}\` to enable companion orientation.`;
}
// Both messages scope the failure to the companion hook. Host MCP has its own
// OAuth grant, so agents must not report Brain itself as unavailable or
// unauthorized based on this packet alone.
export function reauthOrientationMessage(loginCommand = DEFAULT_COMPANION_LOGIN_COMMAND) {
    return `BrainMCP CLI sign-in expired or was revoked, so companion orientation is off. Only the brainmcp hook is affected: host MCP access is independent, so orient through the host brain_* tools (brain_workspace_overview) before saying Brain is unavailable. Tell the user to run \`${loginCommand}\` to restore companion orientation.`;
}
export function companionOrientationFailedMessage(kinds) {
    const reasons = [...new Set(kinds)].join(', ');
    return `BrainMCP companion orientation failed (${reasons}). Only the brainmcp hook is affected: host MCP access is independent, so orient through the host brain_* tools (brain_workspace_overview) before saying Brain is unavailable.`;
}
export function classifyOrientFailure(error) {
    if (error instanceof CompanionReauthRequiredError)
        return { kind: 'reauth_required', status: 401 };
    if (error instanceof OAuthRefreshFailedError)
        return { kind: `refresh_http_${error.refreshStatus}`, status: error.refreshStatus };
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status : undefined;
    if (status === 401)
        return { kind: 'unauthorized', status };
    if (status === 403)
        return { kind: 'forbidden', status };
    if (status !== undefined)
        return { kind: `http_${status}`, status };
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out|cancelled/i.test(message))
        return { kind: 'timeout' };
    return { kind: 'network' };
}
function classifyRefreshFailure(error) {
    const failure = classifyOrientFailure(error);
    if (failure.kind === 'timeout')
        return { kind: 'refresh_timeout' };
    if (failure.kind === 'network')
        return { kind: 'refresh_failed' };
    return failure;
}
/** Any of these means the companion grant needs a new login, not a retry. */
function needsLogin(failure) {
    return failure.kind === 'reauth_required' || failure.kind === 'unauthorized';
}
export class OrientRequestsFailedError extends Error {
    failures;
    constructor(failures) {
        super('No project workspace orientation request succeeded.');
        this.name = 'OrientRequestsFailedError';
        this.failures = failures;
    }
}
export function selectWorkspaceOrientationMessage() {
    return `Companion orientation has no resolved workspace. Continue through the host brain_* tools. ${WORKSPACE_INFERENCE_GUIDANCE}`;
}
/**
 * Resolve only the nearest project policy file; malformed/symlinked files fail
 * closed. A file with no `workspaceId` key binds nothing (`unbind` keeps its
 * other keys, such as a capture opt-out, which capture still honors); only a
 * `workspaceId` that is not a workspace UUID, or an unreadable file, is invalid.
 *
 * The walk stops at the nearest Git root (after reading a file there; for a
 * linked worktree nested in its main checkout, the main checkout's root, see
 * gitEntryEndsBindingWalk), as `brainmcp bind` resolves its target: a file above the repository belongs to
 * another tree, so an unbound repository never inherits a parent directory's
 * binding. Outside any Git repository the walk stops at the home directory
 * (after reading a file there, which only an explicit `bind --root` writes).
 */
const MAX_GITDIR_POINTER_BYTES = 4 * 1024;
/**
 * Whether `dir`'s `.git` entry ends a binding walk. A `.git` directory (a
 * repository root) does. A `.git` file is a gitdir pointer: a linked worktree
 * nested inside its main checkout (for example `<repo>/.claude/worktrees/x`,
 * whose gitdir is `<repo>/.git/worktrees/x`) belongs to that checkout, so the
 * walk continues to the main repository root, which ends it. Any other
 * pointer (a submodule, a worktree outside its checkout, an unreadable file)
 * ends the walk here. `brainmcp bind` resolves its target with the same rule.
 */
export function gitEntryEndsBindingWalk(dir) {
    const entry = path.join(dir, '.git');
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (!stat)
        return false;
    if (!stat.isFile() || stat.size > MAX_GITDIR_POINTER_BYTES)
        return true;
    try {
        const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(entry, 'utf8'));
        if (!match)
            return true;
        const gitdir = path.resolve(dir, match[1]);
        const worktrees = path.dirname(gitdir);
        const mainGitDir = path.dirname(worktrees);
        if (path.basename(worktrees) !== 'worktrees' || path.basename(mainGitDir) !== '.git')
            return true;
        if (!fs.lstatSync(mainGitDir, { throwIfNoEntry: false })?.isDirectory())
            return true;
        // Compared as canonical real paths: git records them resolved (/private/var
        // on macOS), and the pointer's spelling may differ in case from the
        // directory's on a case-insensitive volume.
        const mainRoot = fs.realpathSync.native(path.dirname(mainGitDir));
        const realDir = fs.realpathSync.native(dir);
        return !realDir.startsWith(`${mainRoot}${path.sep}`);
    }
    catch {
        return true;
    }
}
/**
 * Where a binding walk starts: the canonical real path of `dir` (the path
 * itself when it cannot be resolved, for example after it was deleted). Git
 * resolves a symlinked working directory to the tree it is in, and so does
 * the walk: a linked worktree reached through a symlink outside its main
 * checkout (`outer/wt-link` → `<repo>/.claude/worktrees/x`) belongs to that
 * checkout, never to `outer`'s binding. `realpathSync.native` also gives the
 * on-disk case, so the home-directory bound matches on a case-insensitive volume.
 */
export function bindingWalkStart(dir) {
    const resolved = path.resolve(dir);
    try {
        return fs.realpathSync.native(resolved);
    }
    catch {
        return resolved;
    }
}
export function readProjectWorkspaceId(startDir, homeDir = os.homedir()) {
    if (!startDir)
        return { kind: 'none' };
    let dir = bindingWalkStart(startDir);
    const home = bindingWalkStart(homeDir);
    for (let depth = 0; depth < 16; depth += 1) {
        const configPath = path.join(dir, '.brainmcp.json');
        if (fs.existsSync(configPath)) {
            try {
                const stat = fs.lstatSync(configPath);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
                    return { kind: 'invalid', configPath };
                }
                const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    return { kind: 'invalid', configPath };
                if (!('workspaceId' in parsed))
                    return { kind: 'none', configPath };
                const workspaceId = typeof parsed.workspaceId === 'string' ? normalizeWorkspaceId(parsed.workspaceId) : '';
                return isWorkspaceUuid(workspaceId)
                    ? { kind: 'workspace', configPath, workspaceId }
                    : { kind: 'invalid', configPath };
            }
            catch {
                return { kind: 'invalid', configPath };
            }
        }
        // The Git root (a nested worktree's is its main checkout) and the home directory bound the walk.
        if (gitEntryEndsBindingWalk(dir) || dir === home)
            break;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return { kind: 'none' };
}
function invalidProjectWorkspaceMessage() {
    return 'BrainMCP found an invalid nearest `.brainmcp.json` workspaceId and did not guess another workspace. Fix or remove that project policy file.';
}
/**
 * Orientation is never cached (Rules and status must be fresh). Older CLI
 * versions could leave `orient-*.json` files under the account cache directory;
 * login and account switches still delete them so stale orientation text never
 * lingers on disk.
 */
export function clearOrientCache(baseDir) {
    const dir = path.join(resolveStateDir(baseDir), 'cache');
    if (!fs.existsSync(dir))
        return;
    for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith('orient-') || !entry.endsWith('.json'))
            continue;
        try {
            fs.unlinkSync(path.join(dir, entry));
        }
        catch {
            // Best-effort account-switch isolation.
        }
    }
}
export async function fetchSessionStartOrientation(input) {
    let requestDeadline = (input.deadlineAt ?? Date.now() + SESSION_START_TIMEOUT_MS) - SESSION_START_REPORT_MARGIN_MS;
    const remainingMs = () => Math.max(1, requestDeadline - Date.now());
    const initial = resolveOrientWorkspaceId(input.creds);
    if (initial.reason === 'login') {
        return loginOrientationMessage(input.loginCommand);
    }
    if (input.creds?.authType === 'oauth' && input.creds.reauthRequired) {
        return reauthOrientationMessage(input.loginCommand);
    }
    const roots = (input.workspaceRoots?.length ? input.workspaceRoots : input.cwd ? [input.cwd] : [])
        .filter((root, index, all) => Boolean(root) && all.indexOf(root) === index);
    const projectResolutions = roots.map((root) => readProjectWorkspaceId(root));
    if (projectResolutions.some((resolution) => resolution.kind === 'invalid')) {
        return invalidProjectWorkspaceMessage();
    }
    const projectWorkspaceIds = projectResolutions
        .filter((resolution) => resolution.kind === 'workspace')
        .map((resolution) => resolution.workspaceId);
    const hasUnboundRoot = roots.length === 0 || projectResolutions.some((resolution) => resolution.kind === 'none');
    // Refresh an expiring access token before any request. Move the deadline to
    // the caller's cap first, so the refresh and the requests share it: a 2 s
    // refresh starved `/orient` of the normal budget, and a 3.9 s refresh used
    // it all up before the 0.1.34 extension could start (both 2026-10-12).
    if (input.creds?.authType === 'oauth' && input.creds.refreshToken && accessTokenExpiresSoon(input.creds)) {
        if (input.extendDeadline) {
            const granted = input.extendDeadline(Date.now() + SESSION_START_MAX_TIMEOUT_MS);
            requestDeadline = Math.max(requestDeadline, granted - SESSION_START_REPORT_MARGIN_MS);
        }
        const refreshStartedAt = Date.now();
        let refreshed;
        try {
            refreshed = await input.apiClient.refreshAccessTokenIfExpiring({ timeoutMs: remainingMs(), signal: input.signal });
        }
        catch (error) {
            throw new OrientRequestsFailedError([classifyRefreshFailure(error)]);
        }
        if (refreshed) {
            logRuntimeEvent('info', 'orient_access_refreshed', {
                refreshMs: Date.now() - refreshStartedAt,
                requestBudgetMs: Math.max(0, requestDeadline - Date.now()),
            }, input.baseDir);
        }
    }
    let fallbackWorkspaceId = initial.workspaceId;
    if (hasUnboundRoot && !fallbackWorkspaceId) {
        try {
            const listing = await input.apiClient.request(COMPANION_WORKSPACES_PATH, { timeoutMs: remainingMs(), signal: input.signal });
            const next = resolveOrientWorkspaceId(input.creds, listing ?? {});
            fallbackWorkspaceId = next.workspaceId;
        }
        catch (error) {
            // A dead grant must surface as "sign in again", not as an unresolved workspace.
            const failure = classifyOrientFailure(error);
            if (needsLogin(failure))
                throw new OrientRequestsFailedError([failure]);
            fallbackWorkspaceId = null;
        }
    }
    const workspaceIds = [...new Set([
            ...projectWorkspaceIds,
            ...(hasUnboundRoot && fallbackWorkspaceId ? [fallbackWorkspaceId] : []),
        ])];
    if (workspaceIds.length === 0)
        return selectWorkspaceOrientationMessage();
    const results = await Promise.allSettled(workspaceIds.map(async (workspaceId) => {
        let payload;
        try {
            payload = await input.apiClient.request(`/api/workspaces/${apiPathSegment(workspaceId)}/orient`, { timeoutMs: remainingMs(), signal: input.signal });
        }
        catch (error) {
            const paused = paidPlanOrientation(error, workspaceId);
            if (paused)
                return paused;
            throw error;
        }
        return formatOrientDetails(payload, workspaceId);
    }));
    const failures = results.map((result) => result.status === 'rejected' ? classifyOrientFailure(result.reason) : null);
    const failedCount = failures.filter(Boolean).length;
    if (failedCount === results.length) {
        throw new OrientRequestsFailedError(failures);
    }
    if (failedCount > 0) {
        logRuntimeEvent('warn', 'orient_partial_failure', {
            failures: failures.filter((failure) => failure !== null),
        }, input.baseDir);
    }
    const header = [ORIENT_PACKET_HEADER];
    if (failedCount > 0)
        header.push(`${failedCount} workspace request(s) failed; their Brain context was not loaded. Retry those workspaces through host MCP; do not substitute another workspace.`);
    if (hasUnboundRoot && !fallbackWorkspaceId)
        header.push(selectWorkspaceOrientationMessage());
    // Show a bounded number of workspace packets, with a budget for each, so one
    // large response cannot silently erase all later workspaces or their failures.
    const visibleResults = results.slice(0, 8);
    if (results.length > visibleResults.length) {
        header.push(`${results.length - visibleResults.length} additional workspace results omitted. Orient those projects separately through host MCP.`);
    }
    const prefix = header.join('\n');
    const separator = '\n\n---\n\n';
    const perWorkspaceBudget = Math.floor((ORIENT_CONTEXT_MAX_CHARS - prefix.length - 1
        - separator.length * (visibleResults.length - 1)) / visibleResults.length);
    const contexts = visibleResults.map((result, index) => clipContext(result.status === 'fulfilled' ? result.value
        : `Workspace ${workspaceIds[index]}: orientation unavailable (${failures[index]?.kind ?? 'network'}). Call brain_workspace_overview with this workspaceId before dependent work.`, perWorkspaceBudget));
    // Complete orientation responses are never cached: Rules and status must be fresh.
    return `${prefix}\n${contexts.join(separator)}`;
}
export async function safeSessionStartOrientation(input) {
    if (!input.apiClient) {
        return input.creds?.authType === 'oauth'
            ? selectWorkspaceOrientationMessage()
            : loginOrientationMessage(input.loginCommand);
    }
    const startedAt = Date.now();
    try {
        return await fetchSessionStartOrientation(input);
    }
    catch (error) {
        // Keep the classified cause: a bare "request failed" log hid a dead grant
        // behind a "temporarily unavailable" message for weeks. `elapsedMs` tells
        // a slow server from a short budget without a network trace.
        const failures = error instanceof OrientRequestsFailedError ? error.failures : [classifyOrientFailure(error)];
        logRuntimeEvent('warn', 'orient_fetch_failed', { error: error instanceof Error ? error.message : String(error), failures, elapsedMs: Date.now() - startedAt }, input.baseDir);
        return failures.some(needsLogin)
            ? reauthOrientationMessage(input.loginCommand)
            : companionOrientationFailedMessage(failures.map((failure) => failure.kind));
    }
}
//# sourceMappingURL=orient.js.map