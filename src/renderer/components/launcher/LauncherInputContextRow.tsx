// LauncherInputContextRow — small chip row below the launcher input.
// PRD 0.2.7 D7 / Phase F: hosts a workspace chip + (when the multiAgentRuntime
// gate is on) a runtime chip in the same screen slot the thought-mode
// `RecentThoughtsRow` uses (`absolute left-0 right-0 top-full mt-3`). Moving
// these two controls out of the input toolbar de-clutters the launcher input.
//
// Visual: the inner buttons (`WorkspaceSelector`, `RuntimeSelector`) are
// reused as-is — they already carry the chevron / icon / hover-text-color
// styling needed in the chat-tab toolbar. We layer a subtle resting
// background on top via a wrapper so the chips read as distinct affordances
// against the launcher's cream background. The inner button's
// `hover:bg-[var(--hover-bg)]` cleanly overrides the wrapper's lighter
// resting tint on hover; the user perceives one chip with a deepening bg.
// Pre-PRD-0.2.7 polish iteration removed the "Agent 工作区" / "Runtime"
// text labels — the icons + content already convey what each chip is.

import { memo } from 'react';

import RuntimeSelector from '@/components/RuntimeSelector';
import type { Project } from '@/config/types';
import type { RuntimeType, RuntimeDetections } from '../../../shared/types/runtime';

import WorkspaceSelector from './WorkspaceSelector';

interface LauncherInputContextRowProps {
  // Workspace
  projects: Project[];
  selectedProject: Project | null;
  defaultWorkspacePath?: string;
  onSelectWorkspace: (project: Project) => void;
  onAddFolder: () => void;

  // Runtime (only rendered when multiAgentRuntime gate is on AND callers
  // supply onRuntimeChange — keeps the chip out of the row entirely if the
  // experimental feature is off).
  showRuntime: boolean;
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
}

// Resting background that distinguishes the chip area from the launcher's
// cream page background. `var(--paper-inset)` is the project's "sunken
// surface" token — half a step darker than the page, reads as "this is a
// distinct slot". The inner button's existing
// `hover:bg-[var(--hover-bg)]` deepens the tint on hover; the
// `transition-colors` on this wrapper smooths the no-hover-state edge so
// the cursor leaving the button doesn't snap back.
const CHIP_WRAPPER_CLASS =
  'inline-flex items-center rounded-lg bg-[var(--paper-inset)] transition-colors hover:bg-[var(--hover-bg)]';

export default memo(function LauncherInputContextRow({
  projects,
  selectedProject,
  defaultWorkspacePath,
  onSelectWorkspace,
  onAddFolder,
  showRuntime,
  runtime,
  runtimeDetections,
  onRuntimeChange,
}: LauncherInputContextRowProps) {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-[var(--ink-muted)]">
      <div className={CHIP_WRAPPER_CLASS}>
        <WorkspaceSelector
          projects={projects}
          selectedProject={selectedProject}
          defaultWorkspacePath={defaultWorkspacePath}
          onSelect={onSelectWorkspace}
          onAddFolder={onAddFolder}
        />
      </div>
      {showRuntime && runtime && runtimeDetections && onRuntimeChange && (
        <div className={CHIP_WRAPPER_CLASS}>
          <RuntimeSelector
            value={runtime}
            detections={runtimeDetections}
            onChange={onRuntimeChange}
            variant="toolbar"
          />
        </div>
      )}
    </div>
  );
});
