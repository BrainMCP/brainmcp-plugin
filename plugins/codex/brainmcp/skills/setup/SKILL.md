---
name: setup
description: Set up or check the brainMCP plugin: sign in the companion CLI that powers session orientation, opt in to session capture, or diagnose the install. Use when the user asks to set up, log in to, troubleshoot, or enable or disable capture for brainMCP.
---

# brainMCP setup (Codex)

The plugin has two independent sign-ins. Never claim one covers the other.

1. **brain MCP server** (the `brain_*` tools). Run `codex mcp login brain` in a terminal (the desktop app may start it after install).
2. **Companion CLI**, used only by the plugin hooks: SessionStart orientation and, if the user opts in, session capture. Without it the tools still work and the hooks print a reminder.

The CLI ships inside the plugin, so `brainmcp` is not on PATH. From this marketplace it lives at `${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js`; from another marketplace, replace `brainmcp` in that path with its name. When sign-in is needed, the session-start context prints the exact command.

Ask the user to run these in their own terminal. Each opens a browser consent page or changes what is sent, so never run them without the user asking:

- Sign in: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" login`
- Check the install: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" doctor --client codex --scope user`
- Opt in to session capture: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" login --capture-digests`, then `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" capture enable`
- Capture status, opt out, or delete queued local data: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" capture status`, `capture disable`, `capture purge-local`
- Sign out: `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.36/cli/dist/index.js" logout`

Hooks need Node.js 22 or newer on PATH. Uninstalling the plugin leaves `~/.brainmcp` (sign-in, preferences, queue); sign out and purge first if the user wants it gone.
