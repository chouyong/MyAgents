/**
 * CLI-backed capability hints injected into the system prompt.
 *
 * Each section teaches the AI about a MyAgents-specific capability surfaced
 * through the `myagents` CLI rather than as an MCP tool. The brief lives here;
 * the AI fetches full docs on demand via `myagents <topic> readme`.
 *
 * Two scopes
 * ----------
 * - `buildCliToolsAppend(scenario)` — cron / IM media capability hints.
 *   Universal across runtimes (builtin Claude Agent SDK + Codex / Gemini /
 *   Claude Code CLI) since v0.2.11 dropped the corresponding in-process MCP
 *   servers (`cron-tools`, `im-cron`, `im-media`) and unified on the CLI.
 *   Gated by `cliToolsEnabled` in `buildSystemPromptAppend` (set true on all
 *   current runtime paths; the flag is retained for theoretical future
 *   runtimes that might not need the appendix).
 * - `buildWidgetSection(scenario)` — generative-UI widget guidance. Universal:
 *   both builtin SDK and external runtimes load the design contract through
 *   `myagents widget readme <module>` via their shell tool. There is no MCP
 *   path for widgets anymore — this is the single source of truth.
 */

import type { InteractionScenario } from './system-prompt';

// ===== Capability sections =====
//
// Each section is a self-contained block with one responsibility. We stack
// them conditionally per scenario in `buildCliToolsAppend` below.

const SECTION_CRON = `<myagents-cli-cron>
You can create, inspect, and manage MyAgents scheduled tasks from the shell
using the \`myagents cron\` CLI. These tasks run inside MyAgents on a schedule
regardless of which runtime the user is currently chatting with. Use this
whenever the user asks for anything like:

  "每 N 分钟 / 每小时 / 每天 / 定时 / 到 HH:MM 提醒 / 循环检查 / run on a schedule"

Trigger: any request that implies repetition over time.

DO NOT use the system \`cron\` / \`crontab\` / \`at\` / \`launchctl\` / \`schtasks\`
commands for this — they can't see MyAgents state. Only \`myagents cron\` creates
tasks that can invoke the AI with a prompt on a schedule.

Quick reference (full docs: run \`myagents cron readme\`):
  myagents cron list                       # see existing tasks
  myagents cron add --name X --prompt "..." --every 30    # short prompts
  myagents cron add --name X --prompt-file /tmp/p.txt --every 30
      # Long / multiline / quoted prompts — write to a file first (using your
      # normal file-writing tool) and pass --prompt-file. This avoids shell
      # escape problems with quotes, newlines, and backticks.
  myagents cron runs <taskId> --limit 5    # inspect recent executions
  myagents cron remove <taskId>            # delete a task

Pass \`--json\` on any command for machine-parseable output. Non-zero exit means
the command failed; read stderr for the reason. Before running any command,
always call \`myagents cron readme\` once if you haven't yet this session.
</myagents-cli-cron>`;

const SECTION_CRON_EXIT = `<myagents-cli-cron-exit>
You are currently running as a scheduled task AND the task creator enabled
"Allow AI to exit". If the task goal is fully achieved, or further executions
would be pointless or counterproductive, end the task early:

  myagents cron exit --reason "goal achieved: ..."

This marks the task complete and stops future executions. Only use this when
you're sure — the user set up a schedule for a reason. Do NOT use it to bail
out of transient errors; retry instead.
</myagents-cli-cron-exit>`;

const SECTION_IM_MEDIA = `<myagents-cli-im-media>
You are running inside an IM Bot / Agent Channel session. To send a file
(image, document, chart, etc.) to the current chat, use:

  myagents im send-media --file <absolute-path> [--caption "..."]

Workflow:
  1. Generate or write the file to disk using your normal file-writing tools.
  2. Call \`myagents im send-media --file /abs/path\`. The session's bot/chat
     context is resolved automatically from the current Sidecar — you do not
     need to know the botId or chatId.

Use this when the user asks to receive a file, image, screenshot, chart, PDF,
CSV, etc. Do NOT use it for intermediate work files — only the deliverables
the user explicitly wants.

Full docs and supported formats: run \`myagents im readme\`.
</myagents-cli-im-media>`;

/**
 * Single source of truth for the widget trigger rule. Embedded into both the
 * system prompt's `SECTION_WIDGET` (always-on guidance) and the CLI's
 * `myagents widget readme` README (`README_WIDGET` in admin-api.ts), so the
 * two surfaces never drift on what counts as a widget-worthy moment.
 */
export const WIDGET_TRIGGER_GUIDANCE = `your explanation reads better as a picture than as prose: data, comparison, trends, flows, steps, structure, hierarchy, timelines, relationships, tunable concepts, visual metaphors. Route on the content, not on whether the user said "visualize" — if drawing is clearer, draw.`;

const SECTION_WIDGET = `<myagents-generative-ui>
You can embed a <generative-ui-widget> tag in your reply to a desktop user. The HTML inside renders inline as an interactive component — a peer of markdown tables and code blocks, just another medium for landing a point.

Use it whenever ${WIDGET_TRIGGER_GUIDANCE}

Skip it for: one-line answers, chitchat, content the user explicitly asked as plain text or code, IM bot sessions (widgets only render in desktop chat).

Before your first widget in a session, run \`myagents widget readme <module> [<module> ...]\` via your shell tool (e.g. Bash) to load the design contract. Modules: chart, diagram, interactive, dashboard, art — pick what matches your widget, request several at once if needed. Skip if already pulled this session.
</myagents-generative-ui>`;

// ===== Main entries =====

/**
 * Build the external-runtime CLI-tools appendix.
 *
 * Conditional stacking:
 *   - cron CRUD         always (every scenario can benefit from scheduling)
 *   - cron self-exit    only when scenario.type === 'cron' && aiCanExit
 *   - IM media          only in 'im' / 'agent-channel' scenarios
 *
 * Note: generative-UI widget guidance is NOT included here — it is universal
 * across runtimes and emitted separately by `buildWidgetSection()` from
 * `buildSystemPromptAppend()`.
 *
 * Returns an empty string when nothing applies (defensive; not expected in
 * practice since cron is always emitted).
 */
export function buildCliToolsAppend(scenario: InteractionScenario): string {
  const parts: string[] = [];

  // cron — universal
  parts.push(SECTION_CRON);

  // cron self-exit — only inside a cron run that allows it
  if (scenario.type === 'cron' && scenario.aiCanExit) {
    parts.push(SECTION_CRON_EXIT);
  }

  // IM media — IM / agent-channel scenarios only
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(SECTION_IM_MEDIA);
  }

  return parts.join('\n\n');
}

/**
 * Build the generative-UI widget guidance section.
 *
 * Universal across runtimes — emitted for every desktop scenario regardless of
 * whether the session is driven by the builtin Claude Agent SDK or an external
 * CLI. Both paths reach the design contract through `myagents widget readme
 * <module>` invoked via their shell tool.
 *
 * Cron tasks run headless and their output isn't rendered in a live chat view
 * that can host a widget iframe, so widgets are gated to desktop scenarios
 * only.
 */
export function buildWidgetSection(scenario: InteractionScenario): string {
  return scenario.type === 'desktop' ? SECTION_WIDGET : '';
}
