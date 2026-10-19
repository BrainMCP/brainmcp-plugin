# brainMCP plugins

Shared, reviewable project memory for coding agents. [brainMCP](https://www.brainmcp.ai) gives agents graph-native memory over MCP: they read project context before work and write durable learnings back as reviewable proposals.

This repository is generated from the private brainMCP monorepo for each release. Do not edit it by hand; report issues to team@brainmcp.ai.

| Host | Install | Plugin |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace add BrainMCP/brainmcp-plugin` then `claude plugin install brainmcp@brainmcp` | [plugins/claude-code/brainmcp](plugins/claude-code/brainmcp) |
| Codex | `codex plugin marketplace add BrainMCP/brainmcp-plugin` then `codex plugin add brainmcp@brainmcp` | [plugins/codex/brainmcp](plugins/codex/brainmcp) |
| Cursor | Teams and Enterprise: import `BrainMCP/brainmcp-plugin` as a team marketplace. Everyone else: `npx --yes @brainmcp/brainmcp@latest init --client cursor --scope user` | [plugins/cursor/brainmcp](plugins/cursor/brainmcp) |

Hooks need Node.js 22 or newer on PATH. Not yet verified on Windows.

Each plugin's README lists exactly what it connects to and stores. Other agents: `npx --yes @brainmcp/brainmcp@latest init --all --scope user` ([quickstart](https://www.brainmcp.ai/docs/quickstart)).

Privacy policy: https://www.brainmcp.ai/privacy · Terms: https://www.brainmcp.ai/terms · Security: https://www.brainmcp.ai/security
