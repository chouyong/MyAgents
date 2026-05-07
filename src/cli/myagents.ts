/**
 * myagents — Self-Configuration CLI for MyAgents
 *
 * A thin wrapper that parses CLI arguments and forwards them as HTTP requests
 * to the Sidecar's Admin API. All business logic lives in the Sidecar.
 *
 * Environment:
 *   MYAGENTS_PORT — Sidecar port (injected by buildClaudeSessionEnv)
 *
 * No shebang here. `npm run build:cli` (esbuild) injects `#!/usr/bin/env node`
 * through `--banner:js` so the *built* `myagents.js` artifact is what carries
 * the shebang. A leftover `#!/usr/bin/env bun` on this source file used to
 * stack with the banner and produced a TWO-shebang artifact (issue #107):
 * bun parses the first line as shebang, the second line `#!/usr/bin/env node`
 * is then read as JS and rejected as a syntax error. Same outcome under node.
 */

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

// Port is resolved after arg parsing (--port flag can override env)
let PORT = process.env.MYAGENTS_PORT ?? '';
let BASE = '';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

/** Parse CLI arguments into structured flags and positional args */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names']);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      // Support both `--key value` and `--key=value` forms. The equals form
      // is ubiquitous in GNU-style CLIs; without it, callers (especially AI
      // agents) get silently-dropped values + confusing "missing flag" errors
      // downstream.
      const raw = arg.slice(2);
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(0, eq) : raw;
      const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
      // Boolean flags (no value follows)
      if (key === 'help' || key === 'json' || key === 'dry-run' || key === 'disable-nonessential' || key === 'full') {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        if (inlineValue !== undefined) {
          arr.push(inlineValue);
          flags[cKey] = arr;
          i++;
          continue;
        }
        const value = args[i + 1];
        if (value === undefined) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          if (!flags[cKey]) flags[cKey] = [];
          i++;
          continue;
        }
        arr.push(value);
        flags[cKey] = arr;
        i += 2;
        continue;
      }
      // Key-value flags (non-repeatable)
      if (inlineValue !== undefined) {
        flags[camelCase(key)] = inlineValue;
        i++;
        continue;
      }
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      flags[camelCase(key)] = value;
      i += 2;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

/**
 * Reject flags that arrived without a value (parser fell back to `true`
 * when the next token was another `--flag`). Surfaces a clear, exit-1
 * CLI error BEFORE any HTTP call — prevents the downstream handler from
 * seeing a bool where it expected a string and returning an opaque
 * "transport/parse failed" error to the AI caller.
 */
function assertStringFlag(value: unknown, flagName: string): asserts value is string | undefined {
  if (value === true) {
    console.error(`Error: --${flagName} requires a value (e.g. --${flagName} foo or --${flagName}=foo)`);
    process.exit(2);
  }
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const TOP_HELP = `myagents — MyAgents Self-Configuration CLI

Usage: myagents <command> [options]

Commands:
  mcp       Manage MCP tool servers
  model     Manage model providers
  agent     Manage agents & channels (+ 'agent show <id>' for effective defaults)
  runtime   Inspect Agent Runtimes (list installed + describe models/modes)
  skill     Manage skills (install from URL, list, enable/disable, sync)
  cron      Manage scheduled tasks (list/add/runs/exit ...)
  task      Manage Task Center tasks (list/get/update-status/run/rerun ...)
  thought   Manage Task Center thoughts (list/create)
  im        IM runtime actions for current chat (send-media)
  widget    Generative UI widget design guidelines (readme)
  plugin    Manage OpenClaw channel plugins
  config    Read/write application config
  status    Show app running state
  version   Show app version
  reload    Hot-reload configuration

Global flags:
  --help      Show help for any command
  --json      Output as JSON
  --dry-run   Preview changes without applying
  --port NUM  Override Sidecar port (default: $MYAGENTS_PORT)

Examples:
  myagents mcp list
  myagents mcp show playwright
  myagents mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest
  myagents mcp enable playwright --scope both
  myagents mcp oauth discover notion-mcp
  myagents mcp oauth start notion-mcp
  myagents model list
  myagents model set-key deepseek sk-xxx
  myagents skill list
  myagents skill add vercel-labs/skills --skill react-best-practices
  myagents skill add https://github.com/anthropics/skills --plugin document-skills
  myagents skill add "npx skills add foo/bar --skill baz" --force
  myagents skill remove my-skill
  myagents skill sync
  myagents cron list
  myagents runtime list                       # see installed runtimes + install hints
  myagents runtime describe codex             # models + permission modes
  myagents agent show <agent-id>              # effective defaults for a workspace
  myagents task list
  myagents task get <taskId>            # returns metadata + docs paths
                                        # (task.md / verify.md / progress.md /
                                        #  alignment.md — read/edit them with
                                        #  standard Read/Edit/Write tools)
  myagents task update-status <taskId> running --message "starting work"
  myagents task update-status <taskId> verifying
  myagents task update-status <taskId> done --message "bundle size dropped 40%"
  myagents task append-session <taskId> <sessionId>
  myagents task run <taskId>
  myagents task rerun <taskId>
  myagents task create-direct --name "review PR" \\
      --workspaceId proj --workspacePath /path/to/proj \\
      --taskMdContent "Review this PR and file findings in progress.md" \\
      --runtime codex --model gpt-5.2 --permissionMode full-auto
    # Per-task runtime/model/permissionMode overrides — consult
    #   myagents runtime list  +  myagents runtime describe <runtime>
    # before choosing values. Omit any flag to inherit the agent workspace default.
  myagents task create-from-alignment <alignmentSessionId> --name "新任务"
    # Backend auto-inherits workspaceId / workspacePath / sourceThoughtId
    # from the alignment session's metadata (set when 「AI 讨论」 launched).
    # Pass --run to dispatch immediately in the same call.
    # Pass --json for machine-readable output (task_id + docs_path).
    # Same per-task override flags as create-direct apply here.
  myagents thought list
  myagents plugin list
  myagents version
  myagents reload

Run 'myagents <command> --help' for details on a specific command.`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Non-JSON error bodies (e.g. axum 4xx returns plain text like
    // "Failed to deserialize query string: missing field `doc`") would
    // crash `resp.json()` with a SyntaxError — translate to an
    // AdminResponse-shaped error so the caller can surface it cleanly.
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      return {
        success: false,
        error: text.trim() || `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    return await resp.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error('Error: Cannot connect to MyAgents. Is the app running?');
      process.exit(3);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResult(group: string, action: string, result: Record<string, unknown>, jsonMode: boolean, flags: Record<string, unknown> = {}): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    // Structured recovery hint (v0.1.69+): print `→ Run: <command>   <message>`
    // below the error line in human mode so a downstream AI reader has a
    // concrete next step, not just a rejection. JSON mode preserves the full
    // shape via the `JSON.stringify` branch above.
    const hint = result.recoveryHint as { recoveryCommand?: string; message?: string } | undefined;
    if (hint && typeof hint === 'object') {
      if (hint.recoveryCommand) {
        const suffix = hint.message ? `   ${hint.message}` : '';
        console.error(`  \u2192 Run: ${hint.recoveryCommand}${suffix}`);
      } else if (hint.message) {
        console.error(`  ${hint.message}`);
      }
    }
    return;
  }

  // Dry-run
  if (result.dryRun) {
    console.log('[DRY RUN] Would apply:');
    console.log(formatObject(result.preview as Record<string, unknown>));
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Group-specific formatting
  if (group === 'mcp' && action === 'list') {
    printMcpList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'mcp' && action === 'show') {
    printMcpShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'model' && action === 'list') {
    printModelList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'agent' && action === 'list') {
    printAgentList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'list') {
    printCronList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'runs') {
    printCronRuns(result.data as Array<Record<string, unknown>>, !!flags.full);
    return;
  }
  if (group === 'cron' && action === 'run-now') {
    const data = result.data as Record<string, unknown> | undefined;
    if (!data) {
      console.log('✓ Triggered.');
      return;
    }
    console.log(`✓ Triggered ${data.taskId ?? '(unknown)'}`);
    if (data.sessionId) console.log(`  session: ${data.sessionId}`);
    if (data.dispatchedAt) console.log(`  dispatched: ${data.dispatchedAt}`);
    console.log(`  runs:    myagents cron runs ${data.taskId ?? '<id>'} --limit 1`);
    return;
  }
  if (group === 'cron' && action === 'update') {
    // Issue #115 — echo the computed next fire time + tz so users see
    // exactly when their schedule edit will fire next. Avoids the
    // strict-after-now confusion ("I changed to minute 33, why does
    // list show 33 next hour") by anchoring the display at update time.
    const task = result.data as Record<string, unknown> | null;
    const taskId = task?.id ?? '<id>';
    console.log(`✓ Updated ${taskId}`);
    if (task) {
      const sched = task.schedule as Record<string, unknown> | undefined;
      if (sched && sched.kind === 'cron') {
        const tz = (sched.tz as string | undefined) ?? 'UTC';
        console.log(`  schedule: ${sched.expr} (${tz})`);
      }
      const nextRaw = task.nextExecutionAt as string | undefined;
      if (nextRaw) {
        // Format in the schedule's tz (or UTC fallback) so the time the
        // user reads matches the time the scheduler will actually fire.
        const nextDate = new Date(nextRaw);
        if (!Number.isNaN(nextDate.getTime())) {
          const tz = ((task.schedule as Record<string, unknown> | undefined)?.tz as string | undefined) ?? 'UTC';
          let local = '';
          try {
            local = nextDate.toLocaleString('sv-SE', { timeZone: tz, hour12: false });
          } catch {
            local = nextDate.toISOString();
          }
          const diffMs = nextDate.getTime() - Date.now();
          const diffStr = diffMs > 0
            ? ` (in ${formatRelativeMs(diffMs)})`
            : ' (in the past)';
          console.log(`  next fire: ${local} ${tz}${diffStr}`);
        }
      }
    }
    return;
  }
  if (group === 'cron' && action === 'status') {
    printCronStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'plugin' && action === 'list') {
    printPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'list') {
    printTaskList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'task' && action === 'get') {
    printTaskDetail(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'thought' && action === 'list') {
    printThoughtList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'list') {
    printSkillList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'skill' && action === 'info') {
    printSkillInfo(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'skill' && action === 'add') {
    printSkillAdd(result as Record<string, unknown>);
    return;
  }
  if (group === 'mcp' && action === 'oauth') {
    printMcpOAuth(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'version') {
    console.log((result.data as { version: string })?.version ?? 'Unknown');
    return;
  }
  if (group === 'agent' && action === 'runtime-status') {
    printAgentRuntimeStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'agent' && action === 'show') {
    printAgentShow(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'runtime' && action === 'list') {
    printRuntimeList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'runtime' && action === 'describe') {
    printRuntimeDescribe(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'status') {
    printStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'help') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Tool readmes: `cron readme` / `im readme` / any `widget ...` form all
  // return a raw text body in result.data.text. Print it as-is — no padding,
  // no status line, no ticks — so AI can consume it directly as context.
  if (action === 'readme' || group === 'widget') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Task create-* — AI-facing flow: print task_id + docs path + next-step
  // hint + any override echo so the caller doesn't have to guess the id via
  // `ls -lt ~/.myagents/tasks/`. JSON mode above returns the full payload.
  // Both `create-direct` and `create-from-alignment` go through the same
  // `enrichTaskCreateResponse` server-side, so one printer covers both.
  if (group === 'task' && (action === 'create-direct' || action === 'create-from-alignment')) {
    printTaskCreateResult(result.data as Record<string, unknown>);
    return;
  }

  // Task run — print the engine/model the task will execute on, plus the
  // task_id echo so the caller has observability on what was dispatched.
  if (group === 'task' && (action === 'run' || action === 'rerun')) {
    printTaskDispatchResult(action, result.data as Record<string, unknown>);
    return;
  }

  // Generic success output
  const symbol = '\u2713'; // ✓
  const hint = result.hint ? ` ${result.hint}` : '';
  const id = (result.data as Record<string, unknown>)?.id ?? '';
  console.log(`${symbol} ${action} ${id}${hint}`);
}

/**
 * Format output for `task create-from-alignment` (and eventually `task create-direct`).
 *
 * AI scripts need at minimum the `task_id` of the newly minted task so they
 * can call `task run <id>` next. Also surfaces `docs_path` because the AI
 * often wants to tell the human "I wrote the task docs to X" and having
 * that string in the CLI output saves a re-lookup.
 *
 * Plaintext shape deliberately mirrors what `--json` produces so readers
 * can mentally switch between the two without re-learning fields:
 *
 *   ✓ Task created
 *     task_id:   <uuid>
 *     name:      <string>
 *     docs_path: ~/.myagents/tasks/<uuid>/
 *     next:      myagents task run <uuid>
 */
function printTaskCreateResult(data: Record<string, unknown>): void {
  // Handler returns { task, dispatched?, runResult? } — `task` is the full
  // Task record; `dispatched/runResult` appear when the caller passed --run.
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const name = String(task?.name ?? '');
  const home = process.env.HOME ?? '';
  const absDocs = `${home}/.myagents/tasks/${id}/`;
  const displayDocs = home && absDocs.startsWith(home)
    ? `~${absDocs.slice(home.length)}`
    : absDocs;

  console.log('\u2713 Task created');
  if (id) console.log(`  task_id:   ${id}`);
  if (name) console.log(`  name:      ${name}`);
  console.log(`  docs_path: ${displayDocs}`);

  // Surface which runtime/model/permission overrides actually landed on the
  // persisted task (read from the server-returned Task record, not echoed
  // from the request). Visible here — not buried in --json — because the AI
  // needs to confirm "the override I specified stuck" before dispatching.
  // A mismatch between `overridesRequested` and `overridden` indicates the
  // server silently dropped a field, which the AI should flag to the user.
  const overridden = (data?.overridden as string[] | undefined) ?? [];
  const overridesRequested = (data?.overridesRequested as string[] | undefined) ?? [];
  const overrides = (data?.overrides as Record<string, unknown> | undefined) ?? {};
  if (overridden.length > 0) {
    console.log(`  overrides: ${overridden.join(', ')}`);
    for (const field of overridden) {
      const v = overrides[field];
      if (v !== null && v !== undefined && v !== '') {
        const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
        console.log(`    ${field.padEnd(14)} = ${display}`);
      }
    }
  } else {
    console.log('  overrides: (none — inherits workspace defaults)');
  }
  // Drift warning: requested override didn't reach the persisted task.
  const droppedFields = overridesRequested.filter(f => !overridden.includes(f));
  if (droppedFields.length > 0) {
    console.log('');
    console.log(`  \u26A0 warning: requested overrides were NOT persisted: ${droppedFields.join(', ')}`);
    console.log('    This likely indicates a server-side deserialization gap — please report.');
  }

  const nextSteps = data?.nextSteps as Record<string, string> | undefined;
  const dispatch = nextSteps?.dispatch ?? (id ? `myagents task run ${id}` : '');
  if (dispatch) console.log(`  next:      ${dispatch}`);

  // If --run was bundled with create, the backend also dispatched; echo
  // the dispatch summary inline so the caller sees both in one output.
  const runResult = data?.runResult as Record<string, unknown> | undefined;
  if (runResult) {
    console.log('');
    printTaskDispatchResult('run', runResult);
  }
}

/**
 * Format `myagents runtime list` output.
 *
 * Structure each row as `runtime  installed  version  displayName`, with
 * non-installed rows following up on the next line with the install hint.
 * AI callers scan this to learn which `--runtime` values are safe to pass.
 */
function printRuntimeList(rows: Array<Record<string, unknown>>): void {
  if (!rows || rows.length === 0) {
    console.log('No runtimes found.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('RUNTIME', 14) + pad('INSTALLED', 11) + pad('VERSION', 18) + 'NAME');
  for (const row of rows) {
    const rt = String(row.runtime ?? '');
    const installed = row.installed ? 'yes' : 'no';
    const version = String(row.version ?? '').split('\n')[0].slice(0, 16) || '-';
    console.log(pad(rt, 14) + pad(installed, 11) + pad(version, 18) + String(row.displayName ?? ''));
    const hint = row.notInstalledHint;
    if (hint) console.log(`    \u2192 ${String(hint)}`);
  }
  console.log('');
  console.log('Describe a runtime:  myagents runtime describe <runtime>');
}

/**
 * Format `myagents runtime describe <runtime>` output.
 *
 * Show the four things an AI needs before choosing override values:
 *   - install state (version string when installed, install hint otherwise)
 *   - available models  (`--model` accepts any of these)
 *   - permission modes  (`--permissionMode` accepts any of these)
 *   - default permission mode (so the caller knows what "no override" means)
 */
function printRuntimeDescribe(data: Record<string, unknown>): void {
  const runtime = String(data.runtime ?? '');
  const name = String(data.displayName ?? runtime);
  const installed = data.installed ? 'yes' : 'no';
  const version = data.version ? ` (${String(data.version).split('\n')[0]})` : '';
  console.log(`${name}  [${runtime}]`);
  console.log(`  installed: ${installed}${version}`);
  const defaultMode = String(data.defaultPermissionMode ?? '');
  if (defaultMode) console.log(`  default permissionMode: ${defaultMode}`);

  const models = (data.models as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Models:');
  if (models.length === 0) {
    console.log('  (none reported — runtime may not be installed, or has no static model list)');
  } else {
    for (const m of models) {
      const value = String(m.value ?? '');
      const display = String(m.displayName ?? '');
      const mark = m.isDefault ? ' *' : '';
      console.log(`  ${value.padEnd(28) || '(default)'}  ${display}${mark}`);
    }
  }

  const modes = (data.permissionModes as Array<Record<string, unknown>>) ?? [];
  console.log('');
  console.log('Permission modes:');
  if (modes.length === 0) {
    console.log('  (runtime uses the built-in PermissionMode enum; set via --permissionMode)');
  } else {
    for (const mode of modes) {
      const value = String(mode.value ?? '');
      const label = String(mode.label ?? '');
      const desc = String(mode.description ?? '');
      console.log(`  ${value.padEnd(22)} ${label}${desc ? '  —  ' + desc : ''}`);
    }
  }

  const note = data.note;
  if (note) {
    console.log('');
    console.log(`Note: ${String(note)}`);
  }
}

/**
 * Format `myagents agent show <id>` output.
 *
 * Exposes the resolved defaults an AI would need to decide whether a task
 * override is meaningful or a no-op. Keys are printed one-per-line with
 * `(inherits provider / workspace default)` for null/empty values so the
 * reader doesn't have to guess what an absent field means.
 */
function printAgentShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No agent data.');
    return;
  }
  console.log(`Agent:       ${String(data.name ?? '')}`);
  console.log(`  id:        ${String(data.id ?? '')}`);
  console.log(`  enabled:   ${data.enabled ? 'yes' : 'no'}`);
  if (data.workspacePath) console.log(`  workspace: ${String(data.workspacePath)}`);
  const channelCount = data.channelCount;
  if (typeof channelCount === 'number') console.log(`  channels:  ${channelCount}`);
  console.log('');
  console.log('Effective defaults:');
  const defaults = (data.effectiveDefaults as Record<string, unknown>) ?? {};
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '(inherits default)';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  console.log(`  runtime:        ${fmt(defaults.runtime)}`);
  console.log(`  model:          ${fmt(defaults.model)}`);
  console.log(`  permissionMode: ${fmt(defaults.permissionMode)}`);
  console.log(`  providerId:     ${fmt(defaults.providerId)}`);
  if (defaults.runtimeConfig) {
    console.log(`  runtimeConfig:  ${JSON.stringify(defaults.runtimeConfig)}`);
  }
  console.log('');
  console.log('Describe this runtime:  myagents runtime describe <runtime>');
}

/**
 * Format output for `task run` / `task rerun`.
 *
 * Answers the "what will this actually run on?" question so the AI caller
 * can relay engine/model back to the human in chat. `runtime` and `model`
 * are read from the updated Task record — both can be null/undefined
 * (meaning "use agent default" / "use provider default"); we explicitly
 * label that case rather than hiding it.
 */
function printTaskDispatchResult(
  action: string,
  data: Record<string, unknown>,
): void {
  const task = (data?.task as Record<string, unknown>) ?? data;
  const id = String(task?.id ?? '');
  const runtime = (task?.runtime as string) || 'builtin';
  const model = (task?.model as string) || '(agent default)';

  console.log(`\u2713 Task ${action === 'rerun' ? 'redispatched' : 'dispatched'}`);
  if (id) console.log(`  task_id:  ${id}`);
  console.log(`  runtime:  ${runtime}`);
  console.log(`  model:    ${model}`);
}

function printMcpList(servers: Array<Record<string, unknown>>): void {
  if (!servers || servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');
  for (const s of servers) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const builtin = s.isBuiltin ? ' (built-in)' : '';
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter(s => s.enabled).length;
  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);
}

/**
 * Format `myagents mcp show <id>` output.
 *
 * Parallels printAgentShow — prints the user-visible config + enable state
 * (global / per-project) for a single server. Env and headers are rendered
 * as `key = <redacted>` lines when values exist; AI callers can read the
 * structure without ever seeing a secret.
 */
function printMcpShow(data: Record<string, unknown>): void {
  if (!data) {
    console.log('No MCP data.');
    return;
  }
  console.log(`MCP Server:   ${String(data.name ?? '')}`);
  console.log(`  id:         ${String(data.id ?? '')}`);
  console.log(`  type:       ${String(data.type ?? '')}`);
  if (data.description) console.log(`  description:${String(data.description)}`);
  console.log(`  built-in:   ${data.isBuiltin ? 'yes' : 'no'}`);

  const enabled = (data.enabled as { global?: boolean; project?: boolean | null }) ?? {};
  const globalState = enabled.global ? 'enabled' : 'disabled';
  const projectState = enabled.project === null || enabled.project === undefined
    ? '(no active workspace)'
    : enabled.project
      ? 'enabled'
      : 'disabled';
  console.log('');
  console.log('Enable state:');
  console.log(`  global:     ${globalState}`);
  console.log(`  project:    ${projectState}`);
  if (data.workspacePath) console.log(`  workspace:  ${String(data.workspacePath)}`);

  console.log('');
  console.log('Transport:');
  if (data.command) console.log(`  command:    ${String(data.command)}`);
  if (Array.isArray(data.args) && (data.args as unknown[]).length > 0) {
    console.log(`  args:       ${(data.args as unknown[]).map(String).join(' ')}`);
  }
  if (data.url) console.log(`  url:        ${String(data.url)}`);

  const env = data.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    console.log('');
    console.log('Env (values redacted):');
    for (const [k, v] of Object.entries(env)) {
      console.log(`  ${k} = ${v}`);
    }
  }
  const headers = data.headers as Record<string, string> | undefined;
  if (headers && Object.keys(headers).length > 0) {
    console.log('');
    console.log('Headers (values redacted):');
    for (const [k, v] of Object.entries(headers)) {
      console.log(`  ${k} = ${v}`);
    }
  }

  if (data.requiresConfig) {
    console.log('');
    console.log('Note: this server requires configuration before it can be enabled.');
    if (data.websiteUrl) console.log(`  See: ${String(data.websiteUrl)}`);
  }
}

function printModelList(providers: Array<Record<string, unknown>>): void {
  if (!providers || providers.length === 0) {
    console.log('No model providers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');
  for (const p of providers) {
    console.log(pad(String(p.id), 24) + pad(String(p.status), 12) + String(p.name));
  }
}

function printAgentList(agents: Array<Record<string, unknown>>): void {
  if (!agents || agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Status', 10) + pad('Channels', 10) + 'Name');
  for (const a of agents) {
    const status = a.enabled ? 'enabled' : 'disabled';
    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 10) + pad(String(a.channelCount), 10) + String(a.name));
  }
}

function printStatus(data: Record<string, unknown>): void {
  const mcp = data.mcpServers as Record<string, number>;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}

function printCronList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('No cron tasks configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // R9: status carries the raw enum name (Running / Stopped) — the
  // scheduler-state vocabulary. The transient "currently executing" state
  // is a separate concept, surfaced via `t.currentlyExecuting` and
  // rendered as a `*` marker after the task ID. See `cron readme` for
  // the full vocabulary explanation.

  // R6: short time format for "Next" / "Last" columns. Locale-independent,
  // fixed width (16 chars), readable.
  const fmtTime = (iso: unknown): string => {
    if (!iso || typeof iso !== 'string') return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  };

  const fmtDuration = (ms: unknown): string => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  console.log(
    pad('ID', 24) +
    pad('Status', 10) +
    pad('Schedule', 18) +
    pad('Next', 18) +
    pad('Last', 18) +
    pad('Dur', 9) +
    pad('Runs', 6) +
    'Name'
  );
  for (const t of tasks) {
    const schedule = t.schedule
      ? (typeof t.schedule === 'object' && (t.schedule as Record<string, unknown>).kind === 'cron'
        ? String((t.schedule as Record<string, unknown>).expr)
        : `Every ${t.intervalMinutes}m`)
      : `Every ${t.intervalMinutes}m`;
    const lastOk = t.lastRunOk;
    const lastMark = lastOk === true ? '✓ ' : lastOk === false ? '✗ ' : '  ';
    const lastTime = fmtTime(t.lastExecutedAt);
    const last = lastTime === '—' ? '—' : `${lastMark}${lastTime}`;
    // Asterisk marker = a tick is firing this very instant (scheduled or
    // run-now). Distinct from `Running` status — see `cron readme`.
    const idDisplay = `${String(t.id).slice(0, 22)}${t.currentlyExecuting ? '*' : ''}`;
    console.log(
      pad(idDisplay, 24) +
      pad(String(t.status), 10) +
      pad(schedule.slice(0, 16), 18) +
      pad(fmtTime(t.nextExecutionAt), 18) +
      pad(last.slice(0, 17), 18) +
      pad(fmtDuration(t.lastRunDurationMs), 9) +
      pad(String(t.executionCount ?? 0), 6) +
      String(t.name ?? (t.prompt as string)?.slice(0, 40) ?? '')
    );
  }
  const running = tasks.filter(t => t.status === 'Running').length;
  const executing = tasks.filter(t => t.currentlyExecuting === true).length;
  const execNote = executing > 0 ? `, ${executing} executing now` : '';
  console.log(`\n${tasks.length} cron tasks (${running} running${execNote})`);
}

function printCronRuns(runs: Array<Record<string, unknown>>, full: boolean = false): void {
  if (!runs || runs.length === 0) {
    console.log('No execution records.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);

  // PRD 0.2.5 R7 \u2014 collapse all whitespace runs (newlines included) so a
  // multi-line content cell doesn't break column alignment of the next row.
  // `full` mode keeps original content but renders one line per row anyway \u2014
  // user opts into that explicitly.
  const formatCell = (s: string, maxLen: number): string => {
    const collapsed = s.replace(/\s+/g, ' ').trim();
    if (full || collapsed.length <= maxLen) return collapsed;
    return collapsed.slice(0, maxLen - 1) + '\u2026';
  };

  // Locale-independent fixed-width time format (19 chars).
  const fmtTime = (ts: unknown): string => {
    if (!ts) return '?'.padEnd(19);
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '?'.padEnd(19);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  };

  const outputMaxLen = full ? Number.POSITIVE_INFINITY : 80;
  console.log(pad('Time', 21) + pad('Status', 8) + pad('Duration', 12) + 'Output');
  for (const r of runs) {
    const time = fmtTime(r.ts);
    const status = r.ok ? '\u2713' : '\u2717';
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '?';
    const raw = r.ok ? String(r.content ?? '') : String(r.error ?? '');
    const output = formatCell(raw, outputMaxLen);
    console.log(pad(time, 21) + pad(status, 8) + pad(dur, 12) + output);
  }
}

function printCronStatus(data: Record<string, unknown>): void {
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running:     ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) console.log(`Last executed: ${data.lastExecutedAt}`);
  if (data.nextExecutionAt) console.log(`Next execution: ${data.nextExecutionAt}`);
}

function printPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 30) + pad('Version', 12) + 'Name');
  for (const p of plugins) {
    console.log(
      pad(String(p.name ?? p.id ?? '?'), 30) +
      pad(String(p.version ?? '?'), 12) +
      String(p.description ?? '')
    );
  }
  console.log(`\n${plugins.length} plugins installed`);
}

function printSkillList(skills: Array<Record<string, unknown>>): void {
  if (!skills || skills.length === 0) {
    console.log('No skills installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Folder', 28) + pad('Scope', 10) + pad('Enabled', 10) + 'Description');
  for (const s of skills) {
    const enabled = s.enabled === false ? 'off' : 'on';
    const desc = String(s.description ?? '').slice(0, 60);
    console.log(
      pad(String(s.folderName ?? s.name ?? '?').slice(0, 26), 28) +
      pad(String(s.scope ?? 'user'), 10) +
      pad(enabled, 10) +
      desc,
    );
  }
  console.log(`\n${skills.length} skill(s)`);
}

function printSkillInfo(data: Record<string, unknown>): void {
  if (!data) {
    console.log('Skill not found.');
    return;
  }
  const fm = (data.frontmatter as Record<string, unknown>) || {};
  console.log(`Name:        ${fm.name ?? data.name ?? '?'}`);
  console.log(`Folder:      ${data.folderName ?? '?'}`);
  console.log(`Scope:       ${data.scope ?? 'user'}`);
  console.log(`Description: ${fm.description ?? ''}`);
  if (fm.author) console.log(`Author:      ${fm.author}`);
  if (fm['allowed-tools']) console.log(`Allowed:     ${JSON.stringify(fm['allowed-tools'])}`);
  console.log(`Path:        ${data.path ?? ''}`);
}

function printSkillAdd(result: Record<string, unknown>): void {
  const installed = result.installed as Array<Record<string, unknown>> | undefined;
  if (installed && installed.length > 0) {
    console.log(`\u2713 Installed ${installed.length} skill(s):`);
    for (const s of installed) {
      console.log(`  - ${s.folderName} — ${s.description ?? ''}`);
    }
    if (result.sourceUrl) console.log(`\nSource: ${result.sourceUrl}`);
    return;
  }
  // Fall-through: preview / dry-run / error path already handled by generic branch
  console.log(`\u2713 ${result.hint ?? 'done'}`);
}

function printTaskList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('(no tasks)');
    return;
  }
  console.log(`Tasks (${tasks.length}):`);
  for (const t of tasks) {
    const status = String(t.status ?? '?');
    const mode = String(t.executionMode ?? 'once');
    const origin = String(t.dispatchOrigin ?? 'direct');
    console.log(`  ${t.id}  [${status}]  ${t.name}`);
    console.log(
      `     mode=${mode}  origin=${origin}  workspace=${t.workspaceId}  sessions=${
        Array.isArray(t.sessionIds) ? (t.sessionIds as string[]).length : 0
      }`,
    );
  }
}

function printTaskDetail(task: Record<string, unknown>): void {
  if (!task) {
    console.log('(task not found)');
    return;
  }

  // Identity + top-line state
  console.log(`Task: ${task.name ?? '(unnamed)'}`);
  console.log(`  ID:             ${task.id}`);
  const statusLine = String(task.status ?? '?');
  const updatedAt = typeof task.updatedAt === 'number' ? new Date(task.updatedAt).toISOString() : undefined;
  console.log(`  Status:         ${statusLine}${updatedAt ? ` (updated ${updatedAt})` : ''}`);
  console.log(`  Executor:       ${task.executor ?? '?'}`);
  console.log(`  Execution mode: ${task.executionMode ?? '?'}`);
  console.log(`  Dispatch:       ${task.dispatchOrigin ?? '?'}`);
  if (task.workspacePath || task.workspaceId) {
    console.log(`  Workspace:      ${task.workspacePath ?? task.workspaceId}`);
  }
  if (task.description) console.log(`  Description:    ${task.description}`);
  if (task.runMode) console.log(`  Run mode:       ${task.runMode}`);
  if (task.runtime) console.log(`  Runtime:        ${task.runtime}`);
  if (task.model) console.log(`  Model override: ${task.model}`);
  if (task.permissionMode) console.log(`  Permission:     ${task.permissionMode}`);
  if (Array.isArray(task.tags) && (task.tags as string[]).length > 0) {
    console.log(`  Tags:           ${(task.tags as string[]).join(', ')}`);
  }

  // Docs paths — the highlight of `task get`. AI consumers read these
  // files with standard Read/Edit/Write tools; there are no separate
  // `show-doc` / `write-doc` CLIs (removed v0.1.69+).
  const docs = task.docs as Record<string, string | undefined> | undefined;
  if (docs) {
    console.log('\nDocs (read/edit/write these directly — they are YOUR workspace):');
    if (docs.dir) console.log(`  Dir:            ${docs.dir}`);
    if (docs.taskMd) console.log(`  task.md:        ${docs.taskMd}`);
    if (docs.verifyMd) console.log(`  verify.md:      ${docs.verifyMd}`);
    if (docs.progressMd) console.log(`  progress.md:    ${docs.progressMd}`);
    if (docs.alignmentMd) console.log(`  alignment.md:   ${docs.alignmentMd}`);
  }

  // Schedule — only for scheduled / recurring / loop tasks
  const mode = String(task.executionMode ?? 'once');
  if (mode !== 'once') {
    console.log('\nSchedule:');
    if (task.cronExpression) {
      console.log(
        `  Cron:           ${task.cronExpression}${task.cronTimezone ? ` (${task.cronTimezone})` : ''}`,
      );
    } else if (task.intervalMinutes) {
      console.log(`  Interval:       every ${task.intervalMinutes} minute(s)`);
    } else if (task.dispatchAt) {
      const when = typeof task.dispatchAt === 'number' ? new Date(task.dispatchAt).toISOString() : String(task.dispatchAt);
      console.log(`  Dispatch at:    ${when}`);
    }
    if (task.lastExecutedAt) {
      const last = typeof task.lastExecutedAt === 'number' ? new Date(task.lastExecutedAt).toISOString() : String(task.lastExecutedAt);
      console.log(`  Last executed:  ${last}`);
    }
  }

  // End conditions — when present, they're decision-relevant
  const end = task.endConditions as Record<string, unknown> | undefined;
  if (end && (end.deadline || end.maxExecutions || end.aiCanExit === false)) {
    console.log('\nEnd conditions:');
    if (end.deadline) {
      const dl = typeof end.deadline === 'number' ? new Date(end.deadline).toISOString() : String(end.deadline);
      console.log(`  Deadline:       ${dl}`);
    }
    if (end.maxExecutions) console.log(`  Max executions: ${end.maxExecutions}`);
    if (end.aiCanExit === false) console.log(`  AI can exit:    no (must run to end conditions)`);
  }

  // Notification
  const notif = task.notification as Record<string, unknown> | undefined;
  if (notif) {
    console.log('\nNotification:');
    console.log(`  Desktop:        ${notif.desktop !== false ? 'on' : 'off'}`);
    if (notif.botChannelId) console.log(`  Bot channel:    ${notif.botChannelId}`);
  }

  // Sessions + source thought
  const sessionIds = Array.isArray(task.sessionIds) ? (task.sessionIds as string[]) : [];
  if (sessionIds.length > 0) {
    console.log(`\nSessions:         ${sessionIds.join(', ')} (${sessionIds.length} total)`);
  }

  // Recent status changes — last 5, with counter
  const hist = task.statusHistory as Array<Record<string, unknown>> | undefined;
  if (hist && hist.length > 0) {
    const last5 = hist.slice(-5);
    console.log(`\nRecent changes (${last5.length} of ${hist.length}):`);
    for (const h of last5) {
      const at = typeof h.at === 'number' ? new Date(h.at).toISOString() : String(h.at ?? '');
      const actor = String(h.actor ?? '?');
      const source = h.source ? `/${h.source}` : '';
      const from = h.from ?? '—';
      const msg = h.message ? `   "${h.message}"` : '';
      console.log(`  ${at}  ${actor}${source}  ${from} → ${h.to}${msg}`);
    }
  }

  // Footer — next-step hints so the AI / user doesn't have to guess
  console.log('\nNext steps:');
  console.log('  myagents task update-status <id> <status> [--message ...]  # transition state machine');
  console.log('  myagents task run <id>                                     # dispatch immediately');
  console.log('  myagents task rerun <id>                                   # re-arm stopped/blocked task');
  console.log('  myagents task --help                                       # full Task CLI reference');
}

function printThoughtList(thoughts: Array<Record<string, unknown>>): void {
  if (!thoughts || thoughts.length === 0) {
    console.log('(no thoughts)');
    return;
  }
  console.log(`Thoughts (${thoughts.length}):`);
  for (const t of thoughts) {
    const content = String(t.content ?? '');
    const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    const convCount = Array.isArray(t.convertedTaskIds)
      ? (t.convertedTaskIds as string[]).length
      : 0;
    console.log(`  ${t.id}  ${preview}`);
    if (tags.length || convCount) {
      const bits: string[] = [];
      if (tags.length) bits.push(`tags=${tags.join(',')}`);
      if (convCount) bits.push(`tasks=${convCount}`);
      console.log(`     ${bits.join('  ')}`);
    }
  }
}

function printMcpOAuth(data: Record<string, unknown>): void {
  if (!data) return;
  const id = data.id ?? '';

  // discover result
  if (data.required !== undefined) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);
    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');
    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);
    return;
  }

  // status result
  if (data.status !== undefined) {
    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }

  // start result (authUrl present)
  if (data.authUrl) {
    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);
    return;
  }

  // Generic fallback (revoke, etc.)
  console.log(`\u2713 ${id}: done`);
}

function printAgentRuntimeStatus(data: Record<string, unknown>): void {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log('No agents running.');
    return;
  }
  for (const a of entries as Array<Record<string, unknown>>) {
    const enabled = a.enabled ? 'enabled' : 'disabled';
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = (a.channels as Array<Record<string, unknown>>) ?? [];
    if (channels.length === 0) {
      console.log('  No channels');
    } else {
      const pad = (s: string, n: number) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : '';
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : '';
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log('');
  }
}

/// Issue #115 — format a millisecond-precision delta into a coarse
/// "in X" string for `cron update` next-fire echoes. Reads naturally for
/// the cases users care about: a few seconds, a few minutes, an hour-ish,
/// a day-ish. Beyond a day we fall back to days+hours.
function formatRelativeMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;
      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;
      return `${indent}${k}: ${v}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;

  // Top-level help (no args, or bare --help)
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }

  // Resolve port: --port flag overrides env
  PORT = (flags.port as string) || PORT;
  if (!PORT) {
    console.error('Error: MYAGENTS_PORT not set. This CLI runs within the MyAgents app.');
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;

  // Help flag for sub-commands
  if (flags.help) {
    const result = await callApi('help', { path: positional });
    printResult('help', 'help', result, jsonMode);
    return;
  }

  const group = positional[0];
  const action = positional[1] || 'list';

  // Simple commands (no subcommand)
  let result: Record<string, unknown>;
  if (group === 'status') {
    result = await callApi('status');
    printResult('status', 'status', result, jsonMode);
  } else if (group === 'reload') {
    result = await callApi('reload', { workspacePath: flags.workspacePath });
    printResult('reload', 'reload', result, jsonMode);
  } else if (group === 'version') {
    result = await callApi('version');
    printResult('version', 'version', result, jsonMode);
  } else {
    // Build request body based on group/action
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);
    result = await callApi(route, body);

    // --run bundled with `task create-from-alignment`: chain immediately
    // into /task/run using the fresh task_id. Saves the caller one round
    // trip and removes the "which id did I just get?" parsing step.
    // Only fires on success and only when the response actually carries
    // a task.id (older backends without the enriched payload fall
    // through without the run — graceful degradation).
    if (
      group === 'task' &&
      action === 'create-from-alignment' &&
      flags.run &&
      result.success &&
      result.data
    ) {
      const data = result.data as Record<string, unknown>;
      const task = (data.task as Record<string, unknown>) ?? data;
      const newTaskId = task?.id as string | undefined;
      if (newTaskId) {
        const runResult = await callApi('task/run', { id: newTaskId });
        if (!runResult.success) {
          // Flag the failure in the top-level result so exit code reflects
          // it, but keep the successful create payload visible so the user
          // can manually `task run <id>` next. Stick the run error in a
          // distinct field to avoid clobbering the create data.
          result.success = false;
          result.error = `created ${newTaskId} but run failed: ${String(runResult.error ?? 'unknown error')}`;
        } else {
          // Bundle the run result alongside create so printTaskCreateResult
          // can show both sections (task_id + docs_path + runtime/model).
          (result.data as Record<string, unknown>).runResult = runResult.data;
        }
      }
    }

    printResult(group, action, result, jsonMode, flags);
  }

  // Exit with proper code: 0 = success, 1 = business error
  if (result && !result.success) process.exit(1);
}

function buildRoute(group: string, action: string, rest: string[]): string {
  // Handle nested commands like "agent channel list/add/remove"
  if (group === 'agent' && action === 'channel') {
    const channelAction = rest[0] || 'list';
    return `agent/channel/${channelAction}`;
  }
  // Agent runtime status
  if (group === 'agent' && action === 'runtime-status') {
    return 'agent/runtime-status';
  }
  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke
  if (group === 'mcp' && action === 'oauth') {
    const oauthAction = rest[0] || 'status';
    return `mcp/oauth/${oauthAction}`;
  }
  // Tool readmes: `myagents cron readme`, `myagents im readme`, `myagents widget ...`
  if (action === 'readme' && (group === 'cron' || group === 'im' || group === 'widget')) {
    return `readme/${group}`;
  }
  // `widget` only exists for readme lookup — any form of invocation
  // (`myagents widget`, `myagents widget chart`, `myagents widget readme chart`)
  // routes to the same handler. The handler parses modules from the payload.
  if (group === 'widget') {
    return 'readme/widget';
  }
  return `${group}/${action}`;
}

function buildRequestBody(
  group: string,
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  // MCP commands
  if (group === 'mcp') {
    if (action === 'add') {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || 'stdio',
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env as string[] | undefined),
          headers: parseEnvFlags(flags.headers as string[] | undefined),
          description: flags.description,
        },
        dryRun: flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === 'show') {
      return { id: rest[0] || flags.id };
    }
    if (action === 'oauth') {
      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke
      const serverId = rest[1] || (flags.id as string);
      if (!serverId) return { id: undefined }; // will trigger missing field error
      if (oauthAction === 'start') {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,
        };
      }
      return { id: serverId };
    }
    if (action === 'env') {
      const serverId = rest[0];
      const subAction = rest[1]; // set | get | delete
      const envPairs = rest.slice(2);
      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags
      const envInput = subAction === 'delete'
        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)
        : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),
      };
    }
    return {};
  }

  // Model commands
  if (group === 'model') {
    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };
    if (action === 'set-default') return { id: rest[0] || flags.id };
    if (action === 'add') {
      // Structure the provider object from flags
      const provider: Record<string, unknown> = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,           // array (repeatable)
        modelNames: flags.modelNames,   // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential,
      };
      // Build aliases from --aliases sonnet=model-id,opus=model-id
      if (typeof flags.aliases === 'string') {
        const aliases: Record<string, string> = {};
        for (const pair of (flags.aliases as string).split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === 'remove') return { id: rest[0] || flags.id };
    return {};
  }

  // Agent commands
  if (group === 'agent') {
    if (action === 'enable' || action === 'disable') return { id: rest[0] || flags.id };
    if (action === 'show') return { id: rest[0] || flags.id };
    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === 'channel') {
      const channelAction = rest[0] || 'list'; // list | add | remove
      if (channelAction === 'list') return { agentId: rest[1] || flags.agentId };
      if (channelAction === 'add') return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === 'remove') return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }

  // Runtime discovery commands (v0.1.69+): `myagents runtime list|describe`
  // Pure query endpoints — no body mutation — meant to be consulted BEFORE
  // choosing values for `task create-direct --runtime/--model/...`.
  if (group === 'runtime') {
    if (action === 'list') return {};
    if (action === 'describe') return { runtime: rest[0] || flags.runtime };
    return {};
  }

  // Cron commands
  if (group === 'cron') {
    if (action === 'add') {
      // Resolve prompt: --prompt-file (industry standard for long text, avoids
      // shell escape hell for multiline / quoted / backtick content) takes
      // precedence over --prompt when both are set. `--message` is accepted
      // as an alias because the internal wire field is `message` and users
      // naturally reach for it (see issue #101). --prompt wins when both set.
      let promptText = (flags.prompt as string | undefined) ?? (flags.message as string | undefined);
      if (flags.promptFile && typeof flags.promptFile === 'string') {
        try {
          // Lazy load — keep CLI startup fast for non-cron commands.
          const fs = require('fs') as typeof import('fs');
          // Size guard: 1 MB is already pathologically large for a cron prompt
          // (~250k English words). Refuse /dev/zero, runaway files, binaries
          // disguised as text, etc., with a clear error instead of blocking
          // the CLI or flooding Admin API.
          const MAX_PROMPT_BYTES = 1024 * 1024;
          const stat = fs.statSync(flags.promptFile);
          if (stat.size > MAX_PROMPT_BYTES) {
            console.error(`Error: --prompt-file "${flags.promptFile}" is ${stat.size} bytes, exceeds ${MAX_PROMPT_BYTES} (1 MB) limit`);
            process.exit(1);
          }
          const raw = fs.readFileSync(flags.promptFile, 'utf-8');
          // NUL-byte guard: a prompt with embedded NULs is almost certainly a
          // binary file being passed in by mistake, and most downstream JSON
          // serialisation / log processing chokes on them. Refuse explicitly.
          if (raw.includes('\0')) {
            console.error(`Error: --prompt-file "${flags.promptFile}" contains NUL bytes (is this a binary file?)`);
            process.exit(1);
          }
          promptText = raw;
        } catch (err) {
          console.error(`Error: failed to read --prompt-file "${flags.promptFile}": ${err instanceof Error ? err.message : String(err)}`);
          // exit(1) matches the existing CLI convention: 1 = business error,
          // 3 = can't connect to Sidecar. Anything CLI-local falls under 1.
          process.exit(1);
        }
      }
      return {
        name: flags.name,
        message: promptText,
        workspacePath: flags.workspace,
        schedule: normalizeScheduleFlag(flags.schedule),
        intervalMinutes: flags.every ? Number(flags.every) : undefined,
      };
    }
    if (action === 'exit') {
      return { reason: flags.reason || rest[0] };
    }
    if (action === 'readme') {
      return {}; // no body
    }
    if (action === 'start' || action === 'stop' || action === 'remove' || action === 'run-now') {
      return { taskId: rest[0] || flags.id };
    }
    if (action === 'update') {
      // Map CLI flags to Rust field names expected by update_task_fields
      const patch: Record<string, unknown> = {};
      if (flags.name !== undefined) patch.name = flags.name;
      // Accept --message as an alias for --prompt (mirrors `cron add`).
      // --prompt wins when both are set.
      const updatePrompt = (flags.prompt as string | undefined) ?? (flags.message as string | undefined);
      if (updatePrompt !== undefined) patch.prompt = updatePrompt;
      if (flags.schedule !== undefined) patch.schedule = normalizeScheduleFlag(flags.schedule);
      if (flags.every !== undefined) patch.intervalMinutes = Number(flags.every);
      if (flags.model !== undefined) patch.model = flags.model;
      if (flags.permissionMode !== undefined) patch.permissionMode = flags.permissionMode;
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === 'runs') {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : undefined };
    }
    if (action === 'list' || action === 'status') {
      return { workspacePath: flags.workspace };
    }
    return {};
  }

  // IM runtime commands — session-scoped, only work inside an IM Bot session
  if (group === 'im') {
    if (action === 'send-media') {
      return {
        filePath: (flags.file as string) || rest[0],
        caption: flags.caption,
      };
    }
    if (action === 'wake') {
      return { text: flags.text || rest[0] };
    }
    if (action === 'channels') {
      return {};
    }
    if (action === 'readme') {
      return {};
    }
    return {};
  }

  // Generative UI widget readme. Accept any of:
  //   myagents widget                         → action='list',    rest=[]           → modules=[]
  //   myagents widget readme                  → action='readme',  rest=[]           → modules=[]
  //   myagents widget readme chart            → action='readme',  rest=['chart']    → modules=['chart']
  //   myagents widget readme chart interactive → rest=['chart','interactive']       → modules=['chart','interactive']
  //   myagents widget chart                   → action='chart',   rest=[]           → modules=['chart']
  //   myagents widget chart interactive       → action='chart',   rest=['interactive'] → modules=['chart','interactive']
  // Modules = positional args AFTER `widget`, minus any leading `readme`/`list` keyword.
  if (group === 'widget') {
    const candidates = [action, ...rest].filter(Boolean);
    const modules = candidates[0] === 'readme' || candidates[0] === 'list'
      ? candidates.slice(1)
      : candidates;
    return { modules };
  }

  // Plugin commands
  if (group === 'plugin') {
    if (action === 'install') return { npmSpec: rest[0] || flags.npmSpec };
    if (action === 'remove') return { pluginId: rest[0] || flags.pluginId };
    return {};
  }

  // Skill commands
  if (group === 'skill') {
    if (action === 'add') {
      return {
        url: rest[0] || flags.url,
        scope: (flags.scope as string) || 'user',
        plugin: flags.plugin,
        skill: flags.skill,
        force: !!flags.force,
        dryRun: !!flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'info' || action === 'enable' || action === 'disable') {
      return { name: rest[0] || flags.name, scope: (flags.scope as string) || 'user' };
    }
    if (action === 'list' || action === 'sync') {
      return {};
    }
    return {};
  }

  // Config commands
  if (group === 'config') {
    if (action === 'get') return { key: rest[0] || flags.key };
    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };
    return {};
  }

  // Task Center (v0.1.69) — covers all `myagents task <action>` subcommands.
  //
  // The `actor` / `source` trust fields are NOT settable via the CLI; the
  // admin-api handler derives them from the calling process environment
  // (MYAGENTS_PORT present → agent subprocess; otherwise user terminal).
  if (group === 'task') {
    if (action === 'list') {
      return {
        workspaceId: flags.workspaceId,
        status: flags.status,
        tag: flags.tag,
        includeDeleted: flags.includeDeleted,
      };
    }
    if (action === 'get') return { id: rest[0] || flags.id };
    if (action === 'update-status') {
      return {
        id: rest[0],
        status: rest[1],
        message: flags.message,
      };
    }
    if (action === 'append-session') {
      return { id: rest[0], sessionId: rest[1] || flags.sessionId };
    }
    if (action === 'archive') return { id: rest[0], message: flags.message };
    if (action === 'delete') return { id: rest[0] };
    if (action === 'create-direct') {
      assertStringFlag(flags.name, 'name');
      // Resolve task.md body: `--taskMdFile` (industry-standard for long
      // text — avoids shell-escape hell for multi-line / backtick / quoted
      // markdown) takes precedence over `--taskMdContent` when both are
      // set. Mirrors the `cron add --prompt-file` pattern above.
      const taskMdContent = resolveTaskMdContent(flags);
      return {
        name: rest[0] || flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        taskMdContent,
        executionMode: flags.executionMode ?? 'once',
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        // Per-task runtime overrides. Admin-api validates these before
        // forwarding to Rust — if the caller mistypes a value, they get a
        // recovery hint pointing to `runtime list` / `runtime describe`.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
      };
    }
    if (action === 'create-from-alignment') {
      // First positional MUST be the alignmentSessionId. Use --name for the
      // task title (to avoid ambiguity when the user writes a task name that
      // happens to parse as a sessionId). An empty alignmentSessionId will be
      // rejected by the Rust layer's `validate_safe_id`.
      assertStringFlag(flags.name, 'name');
      return {
        name: flags.name,
        executor: flags.executor ?? 'agent',
        description: flags.description,
        workspaceId: flags.workspaceId,
        workspacePath: flags.workspacePath,
        alignmentSessionId: flags.alignmentSessionId ?? rest[0],
        executionMode: flags.executionMode ?? 'once',
        runMode: flags.runMode,
        sourceThoughtId: flags.sourceThoughtId,
        tags: typeof flags.tags === 'string'
          ? (flags.tags as string).split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        // Identical override contract to create-direct above — keep these two
        // in lockstep.
        runtime: flags.runtime,
        model: flags.model,
        permissionMode: flags.permissionMode,
        runtimeConfig: parseRuntimeConfigFlag(flags.runtimeConfig),
      };
    }
    if (action === 'run' || action === 'rerun') {
      return { id: rest[0] || flags.id };
    }
    return {};
  }

  // Thought (v0.1.69) — `myagents thought <list|create>`
  if (group === 'thought') {
    if (action === 'list') {
      return {
        tag: flags.tag,
        query: flags.query,
        limit: flags.limit ? Number(flags.limit) : undefined,
      };
    }
    if (action === 'create') {
      return {
        content: rest.join(' ') || flags.content,
      };
    }
    return {};
  }

  return flags;
}

/** Parse KEY=VALUE pairs from --env flags */
function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs || envPairs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip CLI-global flags that should not be persisted into config data */
function stripGlobalFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const globalKeys = new Set(['json', 'dryRun', 'help', 'port', 'workspacePath']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}

/** Try to parse a string as JSON, otherwise return as-is */
function tryParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Normalize `--schedule` into a CronSchedule object.
 *
 * Accepted forms:
 *   - Cron expression string (legacy, most common):
 *       --schedule "*\/30 * * * *"
 *     → { kind: 'cron', expr: "*\/30 * * * *" }
 *
 *   - JSON object matching CronSchedule (the internal wire shape):
 *       --schedule '{"kind":"at","at":"2026-04-23T09:10:00+08:00"}'
 *       --schedule '{"kind":"every","minutes":30}'
 *       --schedule '{"kind":"cron","expr":"0 9 * * *","tz":"Asia/Shanghai"}'
 *     → parsed object, passed through as-is
 *
 * Fails hard (exit 2) on a malformed JSON-looking input so callers get a
 * clear rejection at the CLI boundary rather than an opaque axum
 * deserialize error three hops away. We detect "looks like JSON" by the
 * leading `{` — a real cron expression never starts with that.
 */
function normalizeScheduleFlag(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --schedule must be a cron expression string or a JSON object (e.g. \'{"kind":"at","at":"2026-04-23T09:10:00+08:00"}\')');
    process.exit(2);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: --schedule looks like JSON but failed to parse: ${msg}`);
      console.error('  Expected shapes: {"kind":"at","at":"<ISO>"} | {"kind":"every","minutes":<n>} | {"kind":"cron","expr":"<expr>"[,"tz":"<tz>"]} | {"kind":"loop"}');
      process.exit(2);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('Error: --schedule JSON must be an object with a "kind" field');
      process.exit(2);
    }
    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;
    if (kind !== 'at' && kind !== 'every' && kind !== 'cron' && kind !== 'loop') {
      console.error(`Error: --schedule JSON has invalid "kind": ${JSON.stringify(kind)} (expected one of: at, every, cron, loop)`);
      process.exit(2);
    }
    // Per-kind required-field validation so missing fields fail at the CLI
    // boundary with a clear message instead of turning into a cryptic Rust
    // deserialize error "Failed to parse JSON" downstream.
    if (kind === 'at' && typeof obj.at !== 'string') {
      console.error('Error: --schedule {"kind":"at"} requires string field "at" (ISO-8601, e.g. "2026-04-23T09:10:00+08:00")');
      process.exit(2);
    }
    if (kind === 'every') {
      if (typeof obj.minutes !== 'number' || !Number.isFinite(obj.minutes)) {
        console.error('Error: --schedule {"kind":"every"} requires numeric field "minutes" (>= 5)');
        process.exit(2);
      }
      if (!Number.isInteger(obj.minutes) || obj.minutes < 5) {
        // Match Rust's `interval_minutes.max(5)` contract — Rust silently clamps
        // but that's a surprise; reject up front for clarity.
        console.error(`Error: --schedule {"kind":"every"}.minutes must be an integer >= 5 (got ${obj.minutes})`);
        process.exit(2);
      }
      if (obj.startAt !== undefined && typeof obj.startAt !== 'string') {
        console.error('Error: --schedule {"kind":"every"}.startAt must be a string (ISO-8601) when provided');
        process.exit(2);
      }
    }
    if (kind === 'cron') {
      if (typeof obj.expr !== 'string') {
        console.error('Error: --schedule {"kind":"cron"} requires string field "expr" (e.g. "0 9 * * *")');
        process.exit(2);
      }
      if (obj.tz !== undefined && obj.tz !== null && typeof obj.tz !== 'string') {
        console.error('Error: --schedule {"kind":"cron"}.tz must be a string (IANA tz name) when provided');
        process.exit(2);
      }
    }
    // 'loop' has no required fields.
    return obj;
  }
  // Non-JSON input → treat as a standard cron expression.
  return { kind: 'cron', expr: trimmed };
}

/** Hard cap for `--taskMdContent` (inline string). Mirrors the `--taskMdFile`
 *  1 MB cap so neither ingress path can ship a pathologically large body
 *  through to Rust, where it would bloat `.task/<id>/task.md` without bound. */
const TASK_MD_MAX_BYTES = 1024 * 1024;

/**
 * Resolve `task create-direct --taskMdFile` / `--taskMdContent` into a
 * single `taskMdContent` string.
 *
 * Precedence (both flags set → `--taskMdFile` wins):
 *   1. `--taskMdFile <path>` — read the file (size + NUL guarded).
 *      Chosen as primary because inline markdown on the shell is hostile to
 *      backticks, quotes, and newlines.
 *   2. `--taskMdContent <string>` — raw inline content (size-guarded).
 *
 * Earlier revisions silently joined trailing positional args as a "legacy"
 * fallback — that was undocumented surface area and a fat-fingered positional
 * could silently become task body. Removed after cross-review (v0.1.69).
 */
function resolveTaskMdContent(
  flags: Record<string, unknown>,
): string | undefined {
  const filePath = flags.taskMdFile;
  if (filePath !== undefined && filePath !== '') {
    if (typeof filePath !== 'string') {
      console.error('Error: --taskMdFile must be a file path string');
      process.exit(2);
    }
    try {
      // Lazy require — same pattern as the cron `--prompt-file` reader
      // (keeps startup fast for commands that don't need fs).
      const fs = require('fs') as typeof import('fs');
      const stat = fs.statSync(filePath);
      if (stat.size > TASK_MD_MAX_BYTES) {
        console.error(`Error: --taskMdFile "${filePath}" is ${stat.size} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit`);
        process.exit(1);
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw.includes('\0')) {
        console.error(`Error: --taskMdFile "${filePath}" contains NUL bytes (is this a binary file?)`);
        process.exit(1);
      }
      return raw;
    } catch (err) {
      console.error(`Error: failed to read --taskMdFile "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const contentFlag = flags.taskMdContent;
  if (typeof contentFlag === 'string' && contentFlag !== '') {
    // Byte-length cap — a 1 MB inline arg on the shell is almost always a
    // copy-paste gone wrong, and downstream JSON serialisation / logging
    // would otherwise choke silently.
    const byteLen = Buffer.byteLength(contentFlag, 'utf-8');
    if (byteLen > TASK_MD_MAX_BYTES) {
      console.error(`Error: --taskMdContent is ${byteLen} bytes, exceeds ${TASK_MD_MAX_BYTES} (1 MB) limit. Use --taskMdFile for large content.`);
      process.exit(1);
    }
    return contentFlag;
  }
  return undefined;
}

/**
 * Parse the value of `--runtimeConfig` (a JSON object string) into an object.
 *
 * Fails hard (exit 2) on malformed JSON — unlike `tryParseJson` which falls
 * back to the raw string. Reason: silently forwarding a broken string to the
 * server would surface as a cryptic Rust deserialization error 3 hops later.
 * An early, typed rejection with "must be a JSON object" is a much more
 * fixable error for the AI caller.
 */
function parseRuntimeConfigFlag(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    console.error('Error: --runtimeConfig must be a JSON object string (e.g. --runtimeConfig \'{"model":"o3"}\')');
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: --runtimeConfig is not valid JSON: ${msg}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('Error: --runtimeConfig must be a JSON object (not array, null, or primitive)');
    process.exit(2);
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
