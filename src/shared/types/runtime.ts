// Multi-Agent Runtime types (v0.1.59)
// Defines runtime types and metadata for external CLI agent integration

/**
 * Available Agent Runtime types
 * - builtin: Built-in Claude Agent SDK (current default)
 * - claude-code: Claude Code CLI (user-installed `claude`)
 * - codex: OpenAI Codex CLI (user-installed `codex`)
 * - gemini: Google Gemini CLI in ACP mode (user-installed `gemini`, v0.1.66+)
 */
export type RuntimeType = 'builtin' | 'claude-code' | 'codex' | 'gemini';

/**
 * Canonical runtime type list — single source of truth.
 *
 * Used by:
 *   - Server-side validation (admin-api.ts task creation guards).
 *   - CLI help-text generation (admin-api.ts HELP_TEXTS).
 *   - Factory / runtime switch statements.
 *
 * Adding a runtime? Update the `RuntimeType` union above, then extend
 * this tuple. The `_exhaustiveRuntimeCheck` helper below makes typecheck
 * fail if the two drift — so you don't get a stale list that compiles
 * silently and produces an incomplete `--help` / validator allowlist.
 */
export const VALID_RUNTIMES = [
  'builtin',
  'claude-code',
  'codex',
  'gemini',
] as const satisfies readonly RuntimeType[];

/**
 * Compile-time exhaustiveness gate: fails `npm run typecheck` if a new
 * `RuntimeType` variant is added to the union without adding the same string
 * to `VALID_RUNTIMES`. The type-level assertion at the bottom never runs at
 * runtime — it just blocks the build on drift.
 */
type _VALID_RUNTIMES_UNION = (typeof VALID_RUNTIMES)[number];
type _AssertRuntimeExhaustive = RuntimeType extends _VALID_RUNTIMES_UNION
  ? _VALID_RUNTIMES_UNION extends RuntimeType
    ? true
    : ['VALID_RUNTIMES has strings not in RuntimeType']
  : ['RuntimeType has variants missing from VALID_RUNTIMES'];
// Exported purely to satisfy the "unused" lint rule — the type-level assertion
// on this declaration is what fails the build on drift; the runtime value
// itself is inert.
export const _exhaustiveRuntimeCheck: _AssertRuntimeExhaustive = true;

/** Human-readable display names keyed by runtime type. */
export const RUNTIME_DISPLAY_NAMES: Record<RuntimeType, string> = {
  builtin: 'Built-in (Claude Agent SDK)',
  'claude-code': 'Claude Code CLI',
  codex: 'OpenAI Codex CLI',
  gemini: 'Google Gemini CLI (ACP)',
};

/**
 * Structured hint for recoverable CLI errors.
 *
 * Emitted by Admin-API handlers when they reject a request for a reason that
 * the caller (AI agent or human) can fix by running one more command. The CLI
 * surfaces `recoveryCommand` as `→ Run: <cmd>` under the error line so the
 * reader can copy-paste to correct course without digging through --help.
 *
 * Design note: kept separate from the existing `AdminResponse.hint: string`
 * field — that one is a free-form success tip ("Server added."), this one is
 * specifically about recovering from failure.
 */
export interface RecoveryHint {
  /** Exact CLI command that will help the caller retry correctly. */
  recoveryCommand?: string;
  /** Short explanatory text shown alongside the command. */
  message?: string;
}

/**
 * Runtime detection result
 */
export interface RuntimeDetection {
  installed: boolean;
  version?: string;
  path?: string;
}

/**
 * All runtime detections keyed by type
 */
export type RuntimeDetections = Record<RuntimeType, RuntimeDetection>;

/**
 * Model info from an external runtime CLI
 */
export interface RuntimeModelInfo {
  value: string;        // Value passed to CLI (e.g., "sonnet", "o3")
  displayName: string;  // UI display name (e.g., "Sonnet 4.6")
  description?: string; // Optional description
  isDefault?: boolean;  // Mark as default selection
}

/**
 * Permission mode for an external runtime
 */
export interface RuntimePermissionMode {
  value: string;        // Value passed to CLI
  label: string;        // UI display label
  icon: string;         // Emoji icon
  description: string;  // Description text
}

/**
 * Runtime-specific configuration stored in AgentConfig
 */
export interface RuntimeConfig {
  model?: string;            // Runtime-specific model selection
  permissionMode?: string;   // Runtime-specific permission mode
  additionalArgs?: string[]; // Extra CLI arguments
}

/**
 * Runtime metadata for UI display
 */
export interface RuntimeInfo {
  type: RuntimeType;
  name: string;
  icon: string;           // Path to icon or built-in identifier
  detection: RuntimeDetection;
}

// ─── Claude Code permission modes ───

export const CC_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'default',
    label: 'Default',
    icon: '\u{1F6E1}',  // 🛡
    description: '每次工具调用都需要确认',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式，只读不执行',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    icon: '\u{1F4DD}',  // 📝
    description: '自动接受文件编辑，其他需确认',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    icon: '\u26A1',      // ⚡
    description: '跳过所有权限确认',
  },
];

// ─── Gemini CLI permission modes (ACP session modes, v0.1.66) ───
//
// These map 1:1 to Gemini CLI's ACP session/new response `modes.availableModes[]`:
//   default  → "Prompts for approval"
//   autoEdit → "Auto-approves edit tools"
//   yolo     → "Auto-approves all tools"
//   plan     → "Read-only mode"
// We keep the internal value equal to Gemini's modeId to avoid a mapping table.

export const GEMINI_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'default',
    label: 'Default',
    icon: '\u{1F6E1}',  // 🛡
    description: '每次工具调用都需要确认',
  },
  {
    value: 'autoEdit',
    label: 'Auto Edit',
    icon: '\u{1F4DD}',  // 📝
    description: '自动接受文件编辑,其他需确认',
  },
  {
    value: 'yolo',
    label: 'YOLO',
    icon: '\u26A1',      // ⚡
    description: '跳过所有工具确认',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式,只读不执行',
  },
];

// ─── Built-in Claude Agent SDK permission modes ───
//
// These mirror the `PermissionMode` string union in `src/server/agent-session.ts`
// (`'auto' | 'plan' | 'fullAgency' | 'custom'`). Exposing them here lets
// `myagents runtime describe builtin` show the same allowlist other runtimes
// expose — otherwise the discovery flow returns an empty permissionModes list
// for builtin and the AI caller has no way to know what values `--permissionMode`
// accepts without reading source code.
export const BUILTIN_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'auto',
    label: 'Auto',
    icon: '\u{1F916}',  // 🤖
    description: '默认模式，工具按需申请权限',
  },
  {
    value: 'plan',
    label: 'Plan',
    icon: '\u{1F4CB}',  // 📋
    description: '规划模式，只读不执行',
  },
  {
    value: 'fullAgency',
    label: 'Full Agency',
    icon: '\u26A1',      // ⚡
    description: '跳过所有权限确认（Cron 任务默认）',
  },
  {
    value: 'custom',
    label: 'Custom',
    icon: '\u{1F527}',  // 🔧
    description: '用户自定义的权限规则',
  },
];

// ─── Codex permission modes (pre-defined for v2) ───

export const CODEX_PERMISSION_MODES: RuntimePermissionMode[] = [
  {
    value: 'suggest',
    label: 'Suggest',
    icon: '\u{1F50D}',  // 🔍
    description: '仅信任的命令自动执行，其他需确认',
  },
  {
    value: 'auto-edit',
    label: 'Auto-Edit',
    icon: '\u{1F4DD}',  // 📝
    description: '自动编辑文件，沙箱内执行命令',
  },
  {
    value: 'full-auto',
    label: 'Full Auto',
    icon: '\u26A1',      // ⚡
    description: '沙箱内自主执行，按需询问',
  },
  {
    value: 'no-restrictions',
    label: 'No Restrictions',
    icon: '\u{1F513}',  // 🔓
    description: '跳过所有审批和沙箱限制',
  },
];

/**
 * Get permission modes for a given runtime type
 *
 * Returns the exhaustive allowlist for every runtime — including builtin —
 * so callers (UI dropdowns, `runtime describe`, validators) don't have to
 * special-case the builtin path.
 */
export function getRuntimePermissionModes(runtime: RuntimeType): RuntimePermissionMode[] {
  switch (runtime) {
    case 'claude-code': return CC_PERMISSION_MODES;
    case 'codex': return CODEX_PERMISSION_MODES;
    case 'gemini': return GEMINI_PERMISSION_MODES;
    case 'builtin': return BUILTIN_PERMISSION_MODES;
    default: return [];
  }
}

// ─── Claude Code model list (canonical, shared) ───

export const CC_MODELS: RuntimeModelInfo[] = [
  { value: '', displayName: '默认', isDefault: true },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
];

// Note: no static GEMINI_MODELS export (unlike CC_MODELS). Gemini's model
// list is fetched dynamically via /api/runtime/models?type=gemini →
// GeminiRuntime.queryModels() → short-lived `gemini --acp` handshake that
// reads `result.models.availableModels` from the session/new response.
// Launcher.tsx and Chat.tsx hold their own `geminiModels` useState seeded
// to [] and populated on the first mount.

/**
 * Get default permission mode for a given runtime type
 */
export function getDefaultRuntimePermissionMode(runtime: RuntimeType): string {
  switch (runtime) {
    case 'claude-code': return 'default';
    case 'codex': return 'full-auto';
    case 'gemini': return 'autoEdit';  // D5: desktop default = Auto Edit
    case 'builtin': return 'auto';
    default: return '';
  }
}

/**
 * Get the highest-permission mode for the given runtime.
 *
 * Used in unattended contexts (cron task dispatch, agent task execution) where
 * "user didn't pick anything" should mean "give me whatever lets the AI
 * actually run without blocking on a human approval that never comes".
 *
 * Distinct from getDefaultRuntimePermissionMode() which returns each runtime's
 * INTERACTIVE default (auto/default/autoEdit/full-auto). Those defaults are
 * correct for chat tabs but pathological for cron — they leave WebSearch /
 * Bash / mcp__* in a pending-approval state that times out on a 10-minute
 * deadline.
 *
 * Per-runtime mapping:
 *   - builtin     → 'fullAgency'        (mapToSdkPermissionMode → bypassPermissions)
 *   - claude-code → 'bypassPermissions' (CC CLI native value, no translation)
 *   - codex       → 'no-restrictions'   (Codex sandbox: skip approvals + sandbox)
 *   - gemini      → 'yolo'              (Gemini ACP: skip all confirmations)
 */
export function getMaxPermissionForRuntime(runtime: RuntimeType): string {
  switch (runtime) {
    case 'builtin':     return 'fullAgency';
    case 'claude-code': return 'bypassPermissions';
    case 'codex':       return 'no-restrictions';
    case 'gemini':      return 'yolo';
    default:            return 'fullAgency';
  }
}

/**
 * Resolve the effective permissionMode for a cron / unattended task tick.
 *
 * Semantics:
 *   - undefined / '' (sentinel "user didn't pick") → runtime max permission
 *   - any other literal value → respected as user's explicit choice
 *
 * Crucially, 'auto' / 'default' / 'autoEdit' / 'full-auto' are NOT treated as
 * "user didn't pick" — they're the runtime's interactive defaults but if a
 * user has them in their cron config, that's a literal value we honor. The
 * only sentinel for "use max" is empty/undefined.
 *
 * (Historical note: pre-v0.2.5, cron config persisted 'auto' as a silent
 * default even when the user never picked anything. The v0.2.5 migration in
 * src-tauri/src/cron_task.rs::load_from_disk clears those values to empty
 * string before they reach this resolver.)
 */
export function resolveCronPermissionMode(
  payloadMode: string | null | undefined,
  snapshotMode: string | null | undefined,
  runtime: RuntimeType,
): string {
  const userMode = (payloadMode || snapshotMode || '').trim();
  if (!userMode) return getMaxPermissionForRuntime(runtime);
  return userMode;
}
