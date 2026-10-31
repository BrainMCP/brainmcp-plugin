# brainMCP for Codex

Version 0.1.43 (guidance 2026.10.28). Shared, reviewable project memory for coding agents: Codex orients from your Brain workspace before work and proposes durable learnings back as reviewable changes.

## Install

```bash
codex plugin marketplace add BrainMCP/brainmcp-plugin
codex plugin add brainmcp@brainmcp
codex mcp login brain
```

Restart Codex and trust the plugin hooks when asked (**Trust all and continue**, or review them with `/hooks`). Codex lists untrusted hooks but does not run them. Codex upgrades this marketplace in the background at startup.

Hooks need Node.js 22 or newer on PATH. Not yet verified on Windows.

Optional, for orientation hooks: sign in the bundled companion CLI with `node "${CODEX_HOME:-$HOME/.codex}/plugins/cache/brainmcp/brainmcp/0.1.43/cli/dist/index.js" login` (the `setup` skill has the details).

## What is inside

- `.mcp.json`: the `brain` server with Brain's stable public `codex` OAuth client.
- `skills/using-brainmcp` and `skills/setup`, available as `brainmcp:using-brainmcp` and `brainmcp:setup`.
- `hooks/hooks.json`: SessionStart, UserPromptSubmit, PostToolUse, PreCompact, and SessionEnd. Hooks inject context; they cannot force a tool call.
- `cli/`: the `@brainmcp/brainmcp` CLI 0.1.43, unmodified and unbundled.

A plugin cannot write AGENTS.md, so every session start adds Brain's always-on guidance (guidance 2026.10.28, in compact form), signed in or not, once you trust the SessionStart hook. It leaves that out when the AGENTS.md in your Codex home (`~/.codex` or `CODEX_HOME`) already has the block `brainmcp init` writes for the same guidance version; a non-empty AGENTS.override.md there replaces AGENTS.md, as in Codex.

If you also ran `brainmcp init` for Codex, rerun it: with the plugin enabled it removes its own `[mcp_servers.brain]` table and hooks and keeps only its AGENTS.md guidance. A config.toml `brain` entry otherwise silently replaces the plugin's.

## What it connects to and stores

- **MCP server** `https://mcp.brainmcp.ai/mcp`, signed in through the host's own OAuth flow. Graph writes are reviewable proposals.
- **Hooks** run `node` with the CLI bundled in `cli/` on Codex lifecycle events. They need Node.js 22 or newer and do nothing remote until the companion CLI is signed in.
- **Companion sign-in** (`login`) uses OAuth discovery at `https://mcp.brainmcp.ai` and the authorization and token endpoints at `https://dash.brainmcp.ai`. Tokens are kept in the OS credential vault, or an owner-only file in `~/.brainmcp` if you allow it.
- **Orientation**: at session start, signed-in hooks read workspace context from `https://api.brainmcp.ai` (`/api/mcp/workspaces`, `/api/workspaces/<id>/orient`). No prompt text is sent.
- **Session capture is off by default.** After `login --capture-digests`, hooks keep a local session ledger in `~/.brainmcp` (prompts only if you also allow them), read the tail of the host's session transcript at PreCompact and SessionEnd and keep only the closing assistant message of each of the latest 3 turns (up to 1,500 characters each), read Git metadata (`git rev-parse`, `branch --show-current`, `diff --numstat`, `status --porcelain`), and a detached background process posts session digests to `https://api.brainmcp.ai/api/workspaces/<id>/digests`. A project can refuse capture with `.brainmcp.json`.
- **Local files**: `~/.brainmcp` holds preferences, session ledgers, the capture queue, an orientation cache, and `logs/runtime.log`. Uninstalling the plugin leaves it; run `logout` and `capture purge-local` first to clear it.

Privacy policy: https://www.brainmcp.ai/privacy · Terms: https://www.brainmcp.ai/terms · Security: https://www.brainmcp.ai/security · Contact: team@brainmcp.ai
