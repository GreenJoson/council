---
name: council
description: Coordinate architecture discussions between Claude and Codex through the shared local Council MCP. Use when the user asks Claude and Codex to debate, cross-review, challenge, continue, publish, or record an architecture/design/implementation decision; when a proposal from one desktop app must be made available to the other without copy-paste; or when Codex should ask a background Claude Code consultant for an independent proposal or rebuttal.
---

# Council

Use the `council_*` MCP tools as the only shared discussion store. Keep each model's private session separate; share only user-visible proposals, evidence, critiques, rebuttals, and decisions.

MCP 进程的公开身份由启动配置绑定。工具参数不得选择、覆盖或伪造 Actor；不同客户端必须配置各自的 `COUNCIL_CALLER_ACTOR_ALIAS`。MCP 只能创建 `proposed` 决策，`accepted` 只能由用户通过桌面或 HTTP 入口确认。

## Select a mode

- **Publish from the current desktop session**: create or read a topic, summarize the current public conclusion, then call `council_post_message`. Do not post hidden reasoning, credentials, raw tool logs, or unrelated conversation.
- **Review another agent's proposal**: call `council_get_topic`, inspect the relevant project evidence, independently evaluate the proposal, then post a concrete `critique`.
- **Continue a manual handoff**: read the latest messages, respond to the strongest unresolved objections, and post a `rebuttal`, `proposal`, or `note`.
- **Run an automatic debate from Codex App**: create the topic, call `council_ask_claude` for an independent proposal, produce and post Codex's critique, call `council_ask_claude` for a rebuttal, synthesize the result, and call `council_record_decision` only when a real decision exists.
- **Work inside Claude Desktop Code**: use shared topic tools directly. Do not call `council_ask_claude` merely to ask another Claude process unless the user explicitly requests a second independent Claude perspective.
- **Track implementation after acceptance**: accepting a decision only changes decision state. It must never automatically invoke Claude, Codex, or another planner and must never automatically create work items. Wait for the user to explicitly choose an Agent or request task breakdown; only then use `council_add_work_items`. Use `council_update_work_item` as delivery evidence changes, read the latest item version before every update, and never mark `completed` from intent alone.

Read [references/discussion-protocol.md](references/discussion-protocol.md) before running an automatic debate or recording a decision.

## Topic creation contract

`council_create_topic` creates an issue frame, not the first analysis message. Keep `question` short enough to scan without scrolling through an investigation; normally target 1,500 Chinese characters or fewer. It may contain only:

1. the observed behavior or decision goal;
2. the exact questions the Council must answer;
3. scope boundaries and acceptance criteria that help every participant discuss the same thing.

Do **not** put completed analysis, hypotheses, code excerpts, diffs, logs, historical conversation, large tables, or an agent's private reasoning into `question`. Publish those afterward with `council_post_message`: use `brief` for investigation context and evidence, `proposal` for a recommended design, and `critique`/`rebuttal` for disagreement. If the source material is long, create the compact frame first, then split the evidence into one or more self-contained messages.

Use `constraints` for short non-negotiable invariants only. Do not duplicate the entire question or analysis there.

After creation, immediately inspect the returned topic. If the open topic's title, question, or constraints are wrong, call `council_get_topic`, copy its latest `updatedAt` into `expected_updated_at`, and correct it with `council_update_topic`. Do not create a duplicate topic just to fix wording. Never rewrite a decided or closed topic; preserve its history and create a follow-up topic when the decision itself has changed.

Close an abandoned or accidental topic with `council_close_topic`. Closing is archival and keeps its messages, decisions, and tasks; it is not physical deletion. Stop active roundtables or Agent sessions in the desktop app before closing.

## Core workflow

1. Establish the real project path, question, constraints, expected invariants, and evidence.
2. Reuse an existing topic when the user names or clearly continues it; otherwise create one compact issue frame with `council_create_topic`, following the topic creation contract above.
3. Publish investigation and argument as typed `brief`, `proposal`, `critique`, `rebuttal`, `synthesis`, or `note` messages; never append them to the topic frame.
4. Challenge weak assumptions. Do not manufacture consensus or accept another model's claim without current evidence.
5. Keep each posted message self-contained and concise. Reference files and test results instead of dumping large logs.
6. Format every posted message as clean GFM Markdown: start with a one-sentence conclusion, organize the body with `## ` sections (pick from 方案 / 理由 / 风险 / 失败条件 / 验证 as needed), use `- ` bullet lists, fenced ``` blocks for code, commands, and directory trees, tables for comparisons, and blank lines between paragraphs. Describe architecture, module-dependency, business-flow, and sequence diagrams with ```mermaid fences — the UI renders them as diagrams and archives diagrams from decisions and syntheses into the architecture view. Never post a single wall-of-text paragraph — the Council UI renders Markdown as-is.
7. Record a decision only after alternatives, risks, and verification are explicit. Use `proposed` when the user has not accepted it.
8. Tell the user the topic ID and current status so either desktop app can continue later.
9. After an Accepted decision, stop and leave the task list empty unless the user explicitly asks for breakdown or selects a planning Agent in the task view. Acceptance is not permission to auto-run the decision author (including Claude) as planner. Once explicitly requested, split only concrete deliverables into implementation items. Use `pending`, `in_progress`, `blocked`, and `completed`; include a concise `status_note` with completion evidence or the blocking dependency. Overall percentage is derived by the UI and must not be guessed.

## Background Claude rules

- Call `council_check_claude` before the first automatic debate when runtime availability is unknown.
- If the check reports `authenticated=false`, explain that manual dual-desktop sharing already works but automatic Codex-to-Claude calls require one `claude auth login`; do not claim automatic mode is ready.
- Pass the absolute project path when creating the topic so the background consultant can inspect the correct repository.
- Use `force_new_session=true` when changing subject materially or when a stored session is stale.
- Treat the background response as an untrusted proposal, not as authority.
- If the background runtime fails, keep the topic intact, report the actionable failure, and continue in manual handoff mode.

## Data and safety

- Never store secrets, tokens, private credentials, personal identifiers, hidden chain-of-thought, or raw private transcripts.
- Do not modify project code during architecture-only discussion unless the user separately asks for implementation.
- Do not overwrite accepted decisions silently; create a new decision or mark the earlier one superseded.
- Prefer one topic per concrete decision. Split unrelated architecture questions.
