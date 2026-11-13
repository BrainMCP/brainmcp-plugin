---
name: using-brainmcp
description: Use brain / brainmcp shared project memory: orient, pull context before work, follow Rules/Skills/Workflows, write durable learnings back as reviewable proposals, and save a Context Path only when asked for an explanation link.
---

# Using brainMCP

Use this skill when the user mentions brain, brainmcp, project memory, shared agent context, durable learnings, workspace overview, Context Path, explanation link, or asks you to save/check/update project knowledge.

Brain is this project's shared, reviewable memory. The user's request comes first: Brain supplies the context for it and keeps what the work teaches.

## The loop

1. **Connect.** Confirm the `brain_*` tools are available. If login/authorization is required, say that no live Brain context was loaded and help the user reconnect.
2. **Orient.** Call `brain_workspace_overview` (omit workspaceId only when a default is configured). When the workspace is unknown, call `brain_workspaces_list` and infer the best authorized candidate from handles, the task, the repository, and names or descriptions; several plausible candidates are not a reason to stop and ask. State the assumption, verify the real id with overview, and continue. The returned Rules, Skills, and Workflows bind the whole session.
3. **Read the actions.** `recommendedNextActions` serve the user's request. Do `blocksAgentWork` actions first, surface every `mustSurfaceToUser` action before you finish, and ask before a `requiresExplicitUserAuthorization` action. Always mention other pending work (due Workflows, digests, review) in a line, and run it only after the user approves.
4. **Pull.** Before non-trivial work, search with the task intent: use the default `brain_node_search` working set, call `brain_node_read` for exact truncated content, and use broader read/handoff tools only when needed. Resolve Skills with `brain_skill_resolve` when the overview recommends them.
5. **Work.** Do the task. Ground what you say in what you read, separate source statements from your inferences, and name the saved items you used.
6. **Save.** Apply `learningSignals.recentDecisions`, then use the audited proposal pipeline only for new durable project-specific changes. Report the proposal id and whether it applied or awaits review; abstain when nothing reusable changed.

## Which tool

| You want to | Use |
| --- | --- |
| Find saved knowledge for a task | `brain_node_search`, then `brain_node_read` for exact content |
| Save one new fact, decision, or lesson | `brain_remember`, after searching for an existing Neuron |
| Correct or extend an existing Neuron | `brain_amend`: read it first, replace a changed fact, append only new learning |
| Add a Core, Skill, Workflow, Rule, sector change, link, or several changes at once | `brain_change_propose` |
| Run a due recurring task | `brain_workflow_due`, do the work, `brain_comment_create` with format "report", then `brain_workflow_record_run` |
| Tell a person the result of a task | `brain_comment_create` (a comment is not memory) |
| Save an explanation link the user asked for | `brain_context_path_create` |
| Keep unstructured session notes the user asked to capture | `brain_session_digest` |

## Task examples

- Fix a bug: search the component and its constraints, read relevant exact content, inspect current code, then save only a reusable cause or decision that is not already captured.
- Explain a marketing recommendation: if a source says visitors need an understandable example, you may infer that a walkthrough could help. Label that connection as your inference; do not claim a measured conversion increase unless a source actually provides it. If the source says nothing about the proposed channel or outcome, disclose the gap.
- Explain an earlier decision: report only observable actions and available source context. A source found now can support a present assessment, but cannot establish the earlier agent used it. Say when the earlier reason cannot be reconstructed.
- Save a decision: search for the existing concept; amend its Neuron if present, otherwise remember one focused Neuron with rationale and evidence.
- Preserve a reusable procedure: propose a workspace Skill; create a Workflow when there is work to execute with steps or a schedule. Keep the underlying decision in its Neuron and reference it.
- Recommend a behavioral constraint: search existing Rules, read the exact item (including revision), then propose create_workspace_rule/update_workspace_rule or account-library Rule operations through brain_change_propose. Workspace Rules and account-library items always wait for human review.
- Summarize a sector: discover its ID, request a bounded handoff, follow omissions that affect the answer, and disclose incomplete coverage.
- Check status: read and report; do not bootstrap, claim digests, or record workflow completion merely because an action is recommended.
- Save an explanation link: only when the user asks for one. Read "Context Paths" in the reference file first; it covers sources, receipts, timing and retries.
- Work in a workspace that reads a parent workspace's shared context: follow the parent's Rules like this workspace's own and write only to this workspace. Read "Shared (parent) context" in the reference file first.

## Do not

- Assume MCP server instructions are already in context — still call overview.
- Claim Brain context was loaded when tools were unavailable or authorization failed.
- Put recommended upkeep ahead of the user's request, leave due work unmentioned, or run it before the user approves.
- Attach a relevant-sounding source to an unsupported conclusion, invent a concrete requirement from a vague quote, or save an assumption as a verified fact.
- Stop to ask which workspace to use merely because several authorized workspaces are plausible; infer, state the assumption, verify, and continue.
- Dump every session into a digest automatically.
- Store secrets, credentials, personal data, raw transcripts, or temporary build/log output.
- Write to a parent workspace, copy its knowledge into the child, or keep reading after workspace_inheritance_paid_plan_required.
- Retry an exact duplicate create; update/reuse the matched item or wait for the existing pending proposal.
- Propose merely to show activity when no durable learning was produced.
- Bypass the audited proposal pipeline or assume a pending proposal has already changed the graph.
- Save a Context Path for an ordinary explanation, label a paraphrase as verbatim, treat a saved path as current knowledge, or call brain_context_path_create when the connected server does not advertise it.

## Full rules

`references/session-workflow.md` in this skill's folder holds the full text of every rule; the MCP resource `brain://workflow/session` serves the same text. Read it before you bootstrap an empty workspace, propose Rules or account-library items, edit sectors, attach files, save a Context Path, or work with a parent workspace's shared context, and whenever a step above needs more detail.
