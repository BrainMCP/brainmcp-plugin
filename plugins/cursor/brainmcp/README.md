# brainMCP for Cursor

Version 0.1.42 (guidance 2026.10.28). Shared, reviewable project memory for coding agents: Cursor agents orient from your Brain workspace before work and propose durable learnings back as reviewable changes.

## Install

For most Cursor users the recommended setup is still `npx --yes @brainmcp/brainmcp@latest init --client cursor --scope user` ([guide](https://www.brainmcp.ai/docs/connect-cursor)), which also adds session-start hooks. This plugin is for Cursor Teams and Enterprise admins: import `BrainMCP/brainmcp-plugin` as a team marketplace (Cursor offers team marketplaces only on those plans), then open **Settings → Tools & MCP**, select **brain**, and connect it. Choose the workspaces this connection may reach in the browser. A Cursor Marketplace listing will follow.

## What is inside

- `mcp.json`: the `brain` server with Brain's public `cursor` OAuth client.
- `rules/brainmcp-workspace.mdc`: an always-applied rule with the Brain workflow.
- `skills/using-brainmcp`: how to use Brain.

This plugin ships no hooks yet. `npx --yes @brainmcp/brainmcp@latest init --client cursor` adds session-start orientation and opt-in capture hooks, but it also writes its own MCP entry and rule, so use either the plugin or `init` for Cursor, not both; two `brain` entries compete for the same OAuth sign-in.

Cursor Cloud Agents need their own MCP connection in the Cursor dashboard; a local authorization does not carry over.

## What it connects to and stores

- **MCP server** `https://mcp.brainmcp.ai/mcp`, signed in through the host's own OAuth flow. Graph writes are reviewable proposals.

Privacy policy: https://www.brainmcp.ai/privacy · Terms: https://www.brainmcp.ai/terms · Security: https://www.brainmcp.ai/security · Contact: team@brainmcp.ai
