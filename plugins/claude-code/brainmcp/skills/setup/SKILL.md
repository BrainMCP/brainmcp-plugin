---
name: setup
description: Set up or check the brainMCP plugin: sign in the companion CLI that powers session orientation, opt in to session capture, or diagnose the install. Use when the user asks to set up, log in to, troubleshoot, or enable or disable capture for brainMCP.
---

# brainMCP setup (Claude Code)

The plugin has two independent sign-ins. Never claim one covers the other.

1. **brain MCP server** (the `brain_*` tools). Run `/mcp`, select `plugin:brainmcp:brain`, and choose **Authenticate**.
2. **Companion CLI**, used only by the plugin hooks: SessionStart orientation and, if the user opts in, session capture. Without it the tools still work and the hooks print a reminder.

The CLI ships inside the plugin, so `brainmcp` is not on PATH. Use the full command below; in Claude Code the user can prefix it with `!` to run it in the session.

Ask the user to run these in their own terminal. Each opens a browser consent page or changes what is sent, so never run them without the user asking:

- Sign in: `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" login`
- Check the install: `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" doctor --client claude-code --scope user`
- Opt in to session capture: `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" login --capture-digests`, then `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" capture enable`
- Capture status, opt out, or delete queued local data: `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" capture status`, `capture disable`, `capture purge-local`
- Sign out: `node "${CLAUDE_PLUGIN_ROOT}/cli/dist/index.js" logout`

Hooks need Node.js 22 or newer on PATH. Uninstalling the plugin leaves `~/.brainmcp` (sign-in, preferences, queue); sign out and purge first if the user wants it gone.
