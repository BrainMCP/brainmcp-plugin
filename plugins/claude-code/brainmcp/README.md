# brainMCP for Claude Code

Version 0.1.43 (guidance 2026.10.28). Shared, reviewable project memory for coding agents: Claude orients from your Brain workspace before work and proposes durable learnings back as reviewable changes.

## Install

```bash
claude plugin marketplace add BrainMCP/brainmcp-plugin
claude plugin install brainmcp@brainmcp
```

Or in a session: `/plugin install brainmcp --marketplace BrainMCP/brainmcp-plugin`. Third-party marketplaces do not auto-update by default; enable it under `/plugin` → Marketplaces, or run `claude plugin update brainmcp@brainmcp`.

Hooks need Node.js 22 or newer on PATH. Not yet verified on Windows.

## Sign in

1. Run `/mcp`, select `plugin:brainmcp:brain`, and choose **Authenticate**. In the browser, pick the workspaces this connection may reach and a default.
2. Optional, for orientation hooks: `! node "<plugin>/cli/dist/index.js" login`. The `setup` skill and the first session start print the exact path.

If your network blocks Dynamic Client Registration, add the server with the static client instead: `claude mcp add --transport http brain https://mcp.brainmcp.ai/mcp --client-id claude-code --callback-port 8765`. That adds a second server, `brain`, beside `plugin:brainmcp:brain`: authenticate `brain` in `/mcp` and disable the plugin's entry there, so the agent uses one brain server.

## What is inside

- `.mcp.json`: the `brain` server, shown as `plugin:brainmcp:brain`.
- `skills/using-brainmcp` (how to use Brain) and `skills/setup` (sign-in, capture, diagnosis).
- `hooks/hooks.json`: SessionStart, UserPromptSubmit, PostToolUse, PreCompact, and SessionEnd. Hooks inject context; they cannot force a tool call.
- `cli/`: the `@brainmcp/brainmcp` CLI 0.1.43, unmodified and unbundled.

A plugin cannot write CLAUDE.md, so every session start adds Brain's always-on guidance (guidance 2026.10.28, in compact form), signed in or not. It leaves that out when `~/.claude/CLAUDE.md` (under `CLAUDE_CONFIG_DIR` when that is set) or the CLAUDE.md at the project root already has the block `brainmcp init` writes for the same guidance version.

If you also ran `brainmcp init` for Claude Code, rerun it: with the plugin enabled it removes its own MCP entry and hooks and keeps only its guidance, so Brain loads once.

## What it connects to and stores

- **MCP server** `https://mcp.brainmcp.ai/mcp`, signed in through the host's own OAuth flow. Graph writes are reviewable proposals.
- **Hooks** run `node` with the CLI bundled in `cli/` on Claude Code lifecycle events. They need Node.js 22 or newer and do nothing remote until the companion CLI is signed in.
- **Companion sign-in** (`login`) uses OAuth discovery at `https://mcp.brainmcp.ai` and the authorization and token endpoints at `https://dash.brainmcp.ai`. Tokens are kept in the OS credential vault, or an owner-only file in `~/.brainmcp` if you allow it.
- **Orientation**: at session start, signed-in hooks read workspace context from `https://api.brainmcp.ai` (`/api/mcp/workspaces`, `/api/workspaces/<id>/orient`). No prompt text is sent.
- **Session capture is off by default.** After `login --capture-digests`, hooks keep a local session ledger in `~/.brainmcp` (prompts only if you also allow them), read the tail of the host's session transcript at PreCompact and SessionEnd and keep only the closing assistant message of each of the latest 3 turns (up to 1,500 characters each), read Git metadata (`git rev-parse`, `branch --show-current`, `diff --numstat`, `status --porcelain`), and a detached background process posts session digests to `https://api.brainmcp.ai/api/workspaces/<id>/digests`. A project can refuse capture with `.brainmcp.json`.
- **Local files**: `~/.brainmcp` holds preferences, session ledgers, the capture queue, an orientation cache, and `logs/runtime.log`. Uninstalling the plugin leaves it; run `logout` and `capture purge-local` first to clear it.

Privacy policy: https://www.brainmcp.ai/privacy · Terms: https://www.brainmcp.ai/terms · Security: https://www.brainmcp.ai/security · Contact: team@brainmcp.ai
