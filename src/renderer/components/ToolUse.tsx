import type React from 'react';
import type { ToolUseSimple } from '@/types/chat';

import BashOutputTool from './tools/BashOutputTool';
import BashTool from './tools/BashTool';
import { CollapsibleTool } from './tools/CollapsibleTool';
import EditTool from './tools/EditTool';
import EdgeTtsTool from './tools/EdgeTtsTool';
import GeminiImageTool from './tools/GeminiImageTool';
import GlobTool from './tools/GlobTool';
import GrepTool from './tools/GrepTool';
import KillShellTool from './tools/KillShellTool';
import NotebookEditTool from './tools/NotebookEditTool';
import ReadTool from './tools/ReadTool';
import SkillTool from './tools/SkillTool';
import TaskTool from './tools/TaskTool';
import TodoWriteTool from './tools/TodoWriteTool';
import ToolAttachmentGallery from './tools/ToolAttachmentGallery';
import WebFetchTool from './tools/WebFetchTool';
import WebSearchTool from './tools/WebSearchTool';
import WriteTool from './tools/WriteTool';
import CronTaskCard from './scheduled-tasks/CronTaskCard';

/**
 * Tools whose specialized component already renders attachments internally.
 * ToolUse skips the outer ToolAttachmentGallery for these to avoid duplicate
 * image rendering. PRD 0.2.15 Review B5.
 *
 * Currently: GeminiImageTool consumes attachments inside its `parseToolResult`
 * code path (it renders via filePath text bridge today; once it migrates to
 * the attachments API in v0.2.16+, both readers will hit the same renderer).
 */
const TOOLS_THAT_OWN_GALLERY_PREFIXES = ['mcp__gemini-image__'];

function ownsAttachmentGallery(toolName: string): boolean {
  return TOOLS_THAT_OWN_GALLERY_PREFIXES.some(p => toolName.startsWith(p));
}

/** Parse cron tool result JSON, returning structured data for card rendering or null on failure */
function parseCronResult(result: string): { taskId: string; name?: string; scheduleDesc?: string; nextExecutionAt?: string } | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed.ok && parsed.taskId) return parsed;
  } catch { /* invalid JSON, fall through */ }
  return null;
}

/** Max chars to display for tool results in the UI.
 *  Larger results (e.g., 16MB Read of a generated HTML file) would create
 *  millions of DOM nodes, destroying virtualization performance.
 *  This is display-only — the full result is still available to the AI.
 *
 *  JSON results (starting with { or [) get a higher limit because
 *  specialized components (TaskTool, WebSearchTool, etc.) parse them
 *  into rich UI — clamping too early would corrupt the JSON. */
const TEXT_DISPLAY_LIMIT = 50_000;
const JSON_DISPLAY_LIMIT = 200_000;

function clampResult(tool: ToolUseSimple): ToolUseSimple {
  if (!tool.result) return tool;
  const trimmed = tool.result.trimStart();
  const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  const limit = isJson ? JSON_DISPLAY_LIMIT : TEXT_DISPLAY_LIMIT;
  if (tool.result.length <= limit) return tool;
  return {
    ...tool,
    result: tool.result.slice(0, limit) + `\n\n... [结果过长，已截断显示前 ${limit.toLocaleString()} 字符，共 ${tool.result.length.toLocaleString()} 字符]`,
  };
}

interface ToolUseProps {
  tool: ToolUseSimple;
}

export default function ToolUse({ tool: rawTool }: ToolUseProps) {
  // Clamp large results for display — but only for general text rendering.
  // Specialized components (cron card, WebSearch, TaskTool, etc.) parse structured
  // JSON from result — clamping would corrupt the JSON and break rich UI.
  const tool = clampResult(rawTool);
  const body = renderToolBody(tool);
  const showGallery = tool.attachments && tool.attachments.length > 0 && !ownsAttachmentGallery(tool.name);
  if (!showGallery) return body;
  return (
    <>
      {body}
      <ToolAttachmentGallery attachments={tool.attachments!} />
    </>
  );
}

function renderToolBody(tool: ToolUseSimple): React.JSX.Element {
  switch (tool.name) {
    case 'Bash':
      return <BashTool tool={tool} />;
    case 'BashOutput':
      return <BashOutputTool tool={tool} />;
    case 'KillShell':
      return <KillShellTool tool={tool} />;
    case 'Read':
      return <ReadTool tool={tool} />;
    case 'Write':
      return <WriteTool tool={tool} />;
    case 'Edit':
      return <EditTool tool={tool} />;
    case 'Glob':
      return <GlobTool tool={tool} />;
    case 'Grep':
      return <GrepTool tool={tool} />;
    case 'Skill':
      return <SkillTool tool={tool} />;
    case 'Task':
    case 'Agent':
      return <TaskTool tool={tool} />;
    case 'TodoWrite':
      return <TodoWriteTool tool={tool} />;
    case 'WebFetch':
      return <WebFetchTool tool={tool} />;
    case 'WebSearch':
      return <WebSearchTool tool={tool} />;
    case 'NotebookEdit':
      return <NotebookEditTool tool={tool} />;
    default: {
      // Route gemini-image MCP tools to custom component
      if (tool.name.startsWith('mcp__gemini-image__')) {
        return <GeminiImageTool tool={tool} />;
      }
      // Route edge-tts MCP tools to custom component
      if (tool.name.startsWith('mcp__edge-tts__')) {
        return <EdgeTtsTool tool={tool} />;
      }
      // Route cron tool results to task card
      if (
        (tool.name.startsWith('mcp__cron-tools__') || tool.name.startsWith('mcp__im-cron__'))
        && tool.result
      ) {
        const cronResult = parseCronResult(tool.result);
        if (cronResult) {
          return (
            <CronTaskCard
              taskId={cronResult.taskId}
              name={cronResult.name}
              scheduleDesc={cronResult.scheduleDesc}
              nextExecutionAt={cronResult.nextExecutionAt}
            />
          );
        }
      }

      // Fallback for unknown tools - show raw JSON
      const collapsedContent = (
        <div className="text-sm text-[var(--ink-muted)]">
          <span className="font-medium">{tool.name}</span>
        </div>
      );

      const expandedContent =
        tool.inputJson ?
          <div className="ml-5">
            <pre className="overflow-x-auto rounded bg-[var(--paper-inset)]/50 px-2 py-1.5 font-mono text-sm wrap-break-word whitespace-pre-wrap text-[var(--ink-secondary)]">
              {tool.inputJson}
            </pre>
          </div>
        : null;

      return (
        <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />
      );
    }
  }
}
