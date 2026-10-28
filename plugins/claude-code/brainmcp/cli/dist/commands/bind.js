import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_EXIT_CODES, CliConfigurationError, isWorkspaceUuid, normalizeWorkspaceId } from '../lib/cli-contracts.js';
import { applyChanges, renderDiff } from '../lib/files.js';
import { bindingWalkStart, gitEntryEndsBindingWalk, readProjectWorkspaceId } from '../runtime/orient.js';
import { readPreferences } from '../runtime/storage.js';
import { WORKSPACE_UUID_REQUIRED } from '../lib/config.js';
/**
 * `brainmcp bind` / `unbind`: the project's `.brainmcp.json` binding. A bound
 * project orients to its own workspace instead of the connection's default,
 * and automatic capture from it never lands in another workspace (hooks skip a
 * project bound elsewhere than the capture workspace). Through 0.1.37 the file
 * had to be written by hand, so most repositories stayed unbound and their
 * sessions were captured into the account capture workspace (2026-10-15).
 */
export const PROJECT_BINDING_FILE = '.brainmcp.json';
/** The same walk limit and size cap the hooks read the binding with (orient.ts, capture.ts). */
const MAX_ANCESTOR_DEPTH = 16;
const MAX_BINDING_BYTES = 64 * 1024;
/**
 * The file a binding belongs in. The walk stops at the nearest Git root (for a
 * linked worktree nested in its main checkout, that checkout's root, the same
 * rule the hooks apply: gitEntryEndsBindingWalk): the nearest existing
 * `.brainmcp.json` at or below it (the one hooks read), else a new one at the
 * Git root. A file above the Git root belongs to some other tree and is never
 * edited from inside this repository. Outside any Git repository the target is
 * the start directory itself, which, like the home directory, needs an
 * explicit `--root`. With `exact` (an explicit `--root`) the target is the
 * start directory's own file, wherever it is.
 */
export function resolveBindTarget(startDir, homeDir = os.homedir(), exact = false) {
    if (exact) {
        const filePath = path.join(path.resolve(startDir), PROJECT_BINDING_FILE);
        return { filePath, exists: fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined };
    }
    // The real path, as the hooks walk it (bindingWalkStart): a symlinked
    // directory binds the tree it is really in.
    const start = bindingWalkStart(startDir);
    let dir = start;
    let nearestFile;
    let gitRoot;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
        const candidate = path.join(dir, PROJECT_BINDING_FILE);
        if (!nearestFile && fs.lstatSync(candidate, { throwIfNoEntry: false }))
            nearestFile = candidate;
        if (gitEntryEndsBindingWalk(dir)) {
            gitRoot = dir;
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    const target = gitRoot
        ? { filePath: nearestFile ?? path.join(gitRoot, PROJECT_BINDING_FILE), exists: Boolean(nearestFile) }
        : (() => {
            const filePath = path.join(start, PROJECT_BINDING_FILE);
            return { filePath, exists: fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined, requiresExplicitRoot: 'no_git_root' };
        })();
    const targetDir = path.dirname(target.filePath);
    if (targetDir === path.resolve(homeDir) || targetDir === bindingWalkStart(homeDir))
        target.requiresExplicitRoot = 'home_directory';
    return target;
}
function refuseImplicitTarget(target) {
    const dir = path.dirname(target.filePath);
    const why = target.requiresExplicitRoot === 'home_directory'
        ? `${dir} is your home directory`
        : `${dir} is not inside a Git repository`;
    throw new CliConfigurationError(`Refusing to write ${target.filePath}: ${why}, so every directory below it that is not inside a Git repository of its own would inherit the binding (a Git repository below it stops at its own root). Run the command inside the repository, or pass \`--root <dir>\` to bind exactly that directory (\`--root ${dir}\` binds this one).`);
}
/** The current file as a JSON object; refuses what the hooks would treat as invalid. */
function readBindingObject(filePath) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BINDING_BYTES) {
        throw new CliConfigurationError(`${filePath} is not a regular file of at most 64 KiB. Fix or remove it, then run the command again.`);
    }
    const text = fs.readFileSync(filePath, 'utf8');
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new CliConfigurationError(`${filePath} is not valid JSON. Fix or remove it, then run the command again.`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CliConfigurationError(`${filePath} must hold a JSON object. Fix or remove it, then run the command again.`);
    }
    return { text, value: value };
}
/** How automatic capture treats a project bound to `workspaceId` (or unbound). */
export function describeCaptureForBinding(workspaceId, baseDir) {
    let prefs;
    try {
        prefs = readPreferences(baseDir);
    }
    catch {
        return undefined; // `doctor` reports unreadable preferences.
    }
    if (!prefs?.consent?.captureEnabled)
        return undefined;
    const captureWorkspace = prefs.enabledWorkspaceId;
    if (!captureWorkspace)
        return 'Session capture is on but has no workspace yet (`brainmcp capture enable --workspace <uuid>`).';
    if (!workspaceId) {
        return `Session capture is on: sessions in this unbound project are captured into workspace ${captureWorkspace}, the account capture workspace.`;
    }
    if (workspaceId === captureWorkspace)
        return `Session capture is on and targets this workspace, so this project's sessions are captured into it.`;
    return `Session capture targets workspace ${captureWorkspace}, so hooks skip this project. To capture its sessions into ${workspaceId} instead, run \`brainmcp capture enable --workspace ${workspaceId}\` (that moves capture for every project).`;
}
/**
 * The `doctor` line for the project's binding. An unbound project passes, and
 * the detail says where its captured sessions go, which is how unrelated
 * repositories ended up in the account capture workspace.
 */
export function checkProjectBinding(startDir, baseDir) {
    const binding = readProjectWorkspaceId(startDir);
    if (binding.kind === 'invalid') {
        return ['project binding', false, `${binding.configPath} has no valid workspaceId, so orientation and capture stop here; run \`brainmcp bind --workspace <uuid>\` or remove the file`];
    }
    const capture = describeCaptureForBinding(binding.kind === 'workspace' ? binding.workspaceId : undefined, baseDir);
    const detail = binding.kind === 'workspace'
        ? `bound to workspace ${binding.workspaceId} (${binding.configPath})`
        : 'not bound (agents orient to the connection default; `brainmcp bind --workspace <uuid>` binds it)';
    return ['project binding', true, capture ? `${detail}. ${capture}` : detail];
}
function render(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
export async function bindProject(options) {
    const target = resolveBindTarget(options.startDir, options.homeDir, options.explicitRoot);
    const current = readProjectWorkspaceId(options.startDir, options.homeDir);
    const currentWorkspace = current.kind === 'workspace' ? current.workspaceId : undefined;
    const report = (data, lines) => {
        if (options.json)
            options.output(JSON.stringify(data, null, 2));
        else
            options.output(lines.filter(Boolean).join('\n'));
    };
    // Status only.
    if (!options.unbind && options.workspace === undefined) {
        const capture = describeCaptureForBinding(currentWorkspace, options.baseDir);
        report({ bound: Boolean(currentWorkspace), workspaceId: currentWorkspace ?? null, file: current.configPath ?? null,
            invalid: current.kind === 'invalid', capture: capture ?? null }, [
            current.kind === 'workspace'
                ? `This project is bound to workspace ${current.workspaceId} (${current.configPath}).`
                : current.kind === 'invalid'
                    ? `${current.configPath} has no valid workspaceId, so orientation and capture stop for this project. Run \`brainmcp bind --workspace <uuid>\` or remove the file.`
                    : `This project is not bound. Agents orient to the connection's default workspace. Bind it with \`brainmcp bind --workspace <uuid>\` (brain_workspaces_list in a connected agent shows workspace UUIDs).`,
            capture ?? '',
        ]);
        return current.kind === 'invalid' ? CLI_EXIT_CODES.CONFIGURATION_ERROR : CLI_EXIT_CODES.SUCCESS;
    }
    if (target.requiresExplicitRoot && !options.explicitRoot)
        refuseImplicitTarget(target);
    if (options.explicitRoot && !fs.statSync(path.dirname(target.filePath), { throwIfNoEntry: false })?.isDirectory()) {
        throw new CliConfigurationError(`--root ${path.dirname(target.filePath)} is not an existing directory.`);
    }
    const existing = target.exists ? readBindingObject(target.filePath) : undefined;
    let nextValue;
    if (options.unbind) {
        if (!existing || !('workspaceId' in existing.value)) {
            // Only `--root <dir>` names a file other than the governing one: a
            // directory below a bound one inherits that binding.
            const inherited = currentWorkspace && current.configPath !== target.filePath ? current.configPath : undefined;
            report({ changed: false, bound: Boolean(inherited), file: existing ? target.filePath : null, inheritedFrom: inherited ?? null }, [inherited
                    ? `${path.dirname(target.filePath)} has no binding of its own; it inherits workspace ${currentWorkspace} from ${inherited}. Nothing changed. To remove that binding, run \`brainmcp unbind --root ${path.dirname(inherited)}\`.`
                    : 'This project has no workspace binding; nothing changed.']);
            return CLI_EXIT_CODES.SUCCESS;
        }
        const rest = { ...existing.value };
        delete rest.workspaceId;
        // Keep other policy keys (a capture opt-out); a file left empty goes away.
        nextValue = Object.keys(rest).length > 0 ? rest : undefined;
    }
    else {
        const workspace = normalizeWorkspaceId(options.workspace);
        if (!isWorkspaceUuid(workspace))
            throw new Error(WORKSPACE_UUID_REQUIRED);
        const existingWorkspace = existing?.value.workspaceId;
        if (typeof existingWorkspace === 'string' && normalizeWorkspaceId(existingWorkspace) === workspace) {
            report({ changed: false, bound: true, workspaceId: workspace, file: target.filePath }, [`This project is already bound to workspace ${workspace} (${target.filePath}).`, describeCaptureForBinding(workspace, options.baseDir) ?? '']);
            return CLI_EXIT_CODES.SUCCESS;
        }
        nextValue = { ...existing?.value, workspaceId: workspace };
    }
    const change = {
        path: target.filePath,
        before: existing?.text,
        after: nextValue ? render(nextValue) : undefined,
        // A repository file: no `.brainmcp.bak-*` copies beside it.
        backup: false,
    };
    if (!options.json)
        options.output(renderDiff(change));
    const confirmed = options.yes || await options.confirm(`${options.unbind ? 'Remove the binding from' : 'Write'} ${target.filePath}?`);
    if (!confirmed) {
        report({ changed: false, cancelled: true, file: target.filePath }, ['Cancelled; nothing was written.']);
        // A declined preview is a general error, as for `init` (README exit codes).
        return CLI_EXIT_CODES.GENERAL_ERROR;
    }
    await applyChanges([change]);
    const boundWorkspace = options.unbind ? undefined : String(nextValue.workspaceId);
    report({ changed: true, bound: Boolean(boundWorkspace), workspaceId: boundWorkspace ?? null, file: target.filePath,
        capture: describeCaptureForBinding(boundWorkspace, options.baseDir) ?? null }, [
        boundWorkspace
            ? `Bound this project to workspace ${boundWorkspace} (${target.filePath}). New agent sessions here orient to it; commit the file to share the binding (it holds only the workspace UUID).`
            : `Removed the workspace binding (${target.filePath}). Agents here orient to the connection's default workspace again.`,
        describeCaptureForBinding(boundWorkspace, options.baseDir) ?? '',
    ]);
    return CLI_EXIT_CODES.SUCCESS;
}
//# sourceMappingURL=bind.js.map