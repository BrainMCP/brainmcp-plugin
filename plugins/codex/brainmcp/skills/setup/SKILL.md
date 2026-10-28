---
name: setup
description: Set up or check the brainMCP plugin: sign in the companion CLI that powers session orientation, opt in to session capture, or diagnose the install. Use when the user asks to set up, log in to, troubleshoot, or enable or disable capture for brainMCP.
---

# brainMCP setup (Codex)

The plugin has two independent sign-ins. Never claim one covers the other.

1. **brain MCP server** (the `brain_*` tools). Run `codex mcp login brain` in a terminal (the desktop app may start it after install).
2. **Companion CLI**, used only by the plugin hooks: SessionStart orientation and, if the user opts in, session capture. Without it the tools still work, and SessionStart still adds Brain's always-on guidance with a sign-in reminder.

The CLI ships inside the plugin, so `brainmcp` is not on PATH. From this marketplace it lives at `${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js`; from another marketplace, replace `brainmcp` in that path with its name. When sign-in is needed, the session-start context prints the exact command.

Ask the user to run these in their own terminal. Each opens a browser consent page or changes what is sent, so never run them without the user asking:

- Sign in: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" login`
- Check the install: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" doctor --client codex --scope user`
- Opt in to session capture: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" login --capture-digests`. It asks for digest access (re-authorizing an existing sign-in that lacks it) and turns capture on for the grant's default workspace; add `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" capture enable --workspace <uuid>` only to capture into another workspace. After a capture policy change, `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" capture enable` accepts the new policy
- Pin this repository to a workspace: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" bind --workspace <uuid>` from inside it (writes `.brainmcp.json` at the Git root; `bind` alone shows the binding, `unbind` removes it)
- Capture status, opt out, or delete queued local data: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" capture status`, `capture disable`, `capture purge-local` (purge deletes captures still waiting for delivery too; `capture now` retries ones that ran out of retries)
- Sign out: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.42/cli/dist/index.js" logout`

## When Brain refuses access

- `brain_workspaces_list` is empty while signed in (`workspace_consent_missing`), or a needed workspace is missing: this connection was not approved for it. Ask the user to add it under that workspace's **Settings → Agent connections** in the dashboard, or to reconnect and choose it on the consent page. Never create a workspace to replace it.
- `parent_context_consent_required`: a person must approve parent read access for this connection under the workspace's **Settings → Agent connections → Parent read access**. Keep working with the workspace's own knowledge meanwhile.
- SessionStart orientation or capture never runs: Codex skips hooks the user has not trusted. Ask the user to review and trust the BrainMCP hooks with `/hooks`.

Hooks need Node.js 22 or newer on PATH. Uninstalling the plugin leaves `~/.brainmcp` (sign-in, preferences, queue); sign out and purge first if the user wants it gone.
