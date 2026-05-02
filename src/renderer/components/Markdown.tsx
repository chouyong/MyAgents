/**
 * Markdown - Enhanced Markdown renderer for AI chat
 * 
 * Features:
 * - Syntax highlighted code blocks with copy button
 * - LaTeX math formulas (KaTeX)
 * - Mermaid diagrams
 * - GFM tables, task lists, strikethrough
 * - External links open in system browser
 */

import 'katex/dist/katex.min.css';

import { memo, useContext, useEffect, useMemo, useState, type ComponentProps } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import CodeBlock from './markdown/CodeBlock';
import InlineCode from './markdown/InlineCode';
import MermaidDiagram from './markdown/MermaidDiagram';
import { openExternal, isExternalUrl } from '@/utils/openExternal';
import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { preprocessMarkdownContent } from '@/utils/markdownPreprocess';

// Sanitize schema: allow safe HTML tags from rehype-raw, strip scripts/iframes/event handlers.
// Extends the default GitHub-flavored schema with additional tags used in AI-generated content.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details', 'summary',  // collapsible sections
    'mark', 'ins', 'del',  // text highlighting
    'sub', 'sup',           // subscript/superscript
    'kbd', 'var', 'samp',  // technical inline elements
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Allow class on code/span for syntax highlighting
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className', 'style'],
    // Allow KaTeX-generated markup
    div: [...(defaultSchema.attributes?.div ?? []), 'className', 'style'],
  },
};

// Static plugin arrays to avoid recreation on every render
const REMARK_PLUGINS_DEFAULT = [remarkGfm, remarkMath];
const REMARK_PLUGINS_WITH_BREAKS = [remarkGfm, remarkMath, remarkBreaks];
const REHYPE_PLUGINS: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeKatex,
];

// Custom link component that opens links in embedded browser panel (if available)
// or falls back to system browser. Supports text selection for copying.
// Strips react-markdown's hast `node` prop so it doesn't get spread onto the DOM <a>.
const MarkdownLink = memo(function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: React.ComponentProps<'a'> & { node?: unknown }) {
  const browserPanel = useContext(BrowserPanelContext);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Check if user is selecting text - don't open link if selecting
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().length > 0;

    if (!hasSelection && href) {
      if (browserPanel && isExternalUrl(href) && !href.toLowerCase().startsWith('mailto:')) {
        // Route to embedded browser panel (exclude mailto: — those go to system email client)
        browserPanel.openUrl(href);
      } else {
        // Fallback: system browser / default app
        openExternal(href);
      }
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-[var(--accent-warm)] underline decoration-[var(--accent-warm)]/40 underline-offset-2 transition-colors hover:text-[var(--accent-warm-hover)] hover:decoration-[var(--accent-warm)]/60"
      style={{ userSelect: 'text' }}
      {...props}
    >
      {children}
    </a>
  );
});

// Custom code component - handles both inline and block code
const CodeComponent: Components['code'] = ({ className, children, node: _node, ...props }) => {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  // Extract text content from children, handling both string and React elements
  // Max depth prevents stack overflow on deeply nested structures (defensive)
  const extractText = (child: React.ReactNode, depth = 0): string => {
    if (depth > 50) return ''; // Defensive: prevent stack overflow
    if (typeof child === 'string') return child;
    if (typeof child === 'number') return String(child);
    if (Array.isArray(child)) return child.map(c => extractText(c, depth + 1)).join('');
    if (child && typeof child === 'object' && 'props' in child) {
      const element = child as { props?: { children?: React.ReactNode } };
      if (element.props?.children) {
        return extractText(element.props.children, depth + 1);
      }
    }
    return '';
  };

  const codeString = extractText(children).replace(/\n$/, '');

  // Check if this is a block code (has language or multiple lines)
  const isBlock = match || codeString.includes('\n');

  if (isBlock) {
    // Special handling for Mermaid diagrams
    if (language === 'mermaid') {
      return <MermaidDiagram>{codeString}</MermaidDiagram>;
    }

    return (
      <CodeBlock language={language} className={className}>
        {codeString}
      </CodeBlock>
    );
  }

  // Inline code
  return <InlineCode {...props}>{children}</InlineCode>;
};

// Custom pre component - wrapper for code blocks
const PreComponent: Components['pre'] = ({ children }) => {
  // Just pass through - CodeBlock handles the styling
  return <>{children}</>;
};

// Custom table components for better styling
const TableComponent: Components['table'] = ({ children }) => (
  <div className="my-4 overflow-x-auto rounded-lg border border-[var(--line)]">
    <table className="m-0 min-w-full divide-y divide-[var(--line)]">
      {children}
    </table>
  </div>
);

const TableHeadComponent: Components['thead'] = ({ children }) => (
  <thead className="bg-[var(--paper-inset)]/40">{children}</thead>
);

const TableRowComponent: Components['tr'] = ({ children }) => (
  <tr className="border-b border-[var(--line-subtle)] last:border-0">
    {children}
  </tr>
);

const TableCellComponent: Components['td'] = ({ children }) => (
  <td className="px-4 py-2.5 text-sm">{children}</td>
);

const TableHeaderComponent: Components['th'] = ({ children }) => (
  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
    {children}
  </th>
);

// Custom blockquote for better styling
const BlockquoteComponent: Components['blockquote'] = ({ children }) => (
  <blockquote className="my-4 border-l-2 border-[var(--line-strong)] py-1 pl-4 pr-3 text-[var(--ink-muted)]">
    {children}
  </blockquote>
);

// Custom heading components - H1:22px H2:20px H3:18px H4-H6:16px
const H1Component: Components['h1'] = ({ children }) => (
  <h1 className="mb-4 mt-6 text-[22px] leading-[1.3] font-bold text-[var(--ink)]">
    {children}
  </h1>
);

const H2Component: Components['h2'] = ({ children }) => (
  <h2 className="mb-3 mt-5 text-[20px] leading-[1.4] font-semibold text-[var(--ink)]">
    {children}
  </h2>
);

const H3Component: Components['h3'] = ({ children }) => (
  <h3 className="mb-2 mt-4 text-[18px] leading-[1.5] font-semibold text-[var(--ink)]">
    {children}
  </h3>
);

const H4Component: Components['h4'] = ({ children }) => (
  <h4 className="mb-2 mt-3 text-[16px] leading-[1.5] font-semibold text-[var(--ink-secondary)]">
    {children}
  </h4>
);

const H5Component: Components['h5'] = ({ children }) => (
  <h5 className="mb-2 mt-3 text-[16px] leading-[1.5] font-medium text-[var(--ink-secondary)]">
    {children}
  </h5>
);

const H6Component: Components['h6'] = ({ children }) => (
  <h6 className="mb-2 mt-3 text-[16px] leading-[1.5] font-medium text-[var(--ink-muted)]">
    {children}
  </h6>
);

// Custom list components
const UlComponent: Components['ul'] = ({ children }) => (
  <ul className="my-3 ml-6 block list-outside list-disc space-y-2.5 text-[var(--ink)] marker:text-[var(--ink-muted)]">
    {children}
  </ul>
);

const OlComponent: Components['ol'] = ({ children, start }) => (
  <ol start={start} className="my-3 ml-6 block list-outside list-decimal space-y-2.5 text-[var(--ink)] marker:text-[var(--ink-muted)]">
    {children}
  </ol>
);

const LiComponent: Components['li'] = ({ children }) => (
  <li className="pl-1 [&>p]:my-0" style={{ display: 'list-item' }}>{children}</li>
);

// Paragraph component
const ParagraphComponent: Components['p'] = ({ children }) => (
  <p className="my-4 leading-relaxed">{children}</p>
);

// Horizontal rule
const HrComponent: Components['hr'] = () => (
  <hr className="my-6 border-[var(--line)]" />
);

// Combine all custom components
const markdownComponents: Components = {
  a: MarkdownLink,
  code: CodeComponent,
  pre: PreComponent,
  table: TableComponent,
  thead: TableHeadComponent,
  tr: TableRowComponent,
  td: TableCellComponent,
  th: TableHeaderComponent,
  blockquote: BlockquoteComponent,
  p: ParagraphComponent,
  hr: HrComponent,
  h1: H1Component,
  h2: H2Component,
  h3: H3Component,
  h4: H4Component,
  h5: H5Component,
  h6: H6Component,
  ul: UlComponent,
  ol: OlComponent,
  li: LiComponent,
};

interface MarkdownProps {
  children: string;
  /** Use compact styling for smaller spaces like thinking blocks */
  compact?: boolean;
  /** Preserve single newlines as line breaks (useful for user messages in chat) */
  preserveNewlines?: boolean;
  /** Skip preprocessing (for rendering complete documents like file preview) */
  raw?: boolean;
  /** Document base directory path (relative to agentDir) for resolving relative image paths */
  basePath?: string;
}

/**
 * Resolve a relative path against a base directory.
 * Handles ./ and ../ prefixes, normalizes the result.
 */
function resolveRelativePath(baseDir: string, src: string): string {
  // Strip leading ./
  const cleaned = src.replace(/^\.\//, '');
  // Combine base dir and relative path
  const parts = (baseDir ? baseDir + '/' + cleaned : cleaned).split('/').filter(Boolean);
  // Resolve .. by walking the parts
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/** Whether a URL is absolute (http/https/data/blob) */
function isAbsoluteUrl(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/** Safely decode URI component, returning original on malformed input */
function safeDecodeURIComponent(str: string): string {
  try { return decodeURIComponent(str); } catch { return str; }
}

/**
 * Image component that resolves relative paths via the Rust workspace_files
 * download command. Only used when basePath is provided (file preview mode).
 *
 * Phase D.5: switched from sidecar `/agent/download` HTTP fetch to
 * `useWorkspaceFileService.readFileAsBlobUrl` invoke. The blob-URL handle
 * is the source of truth for cleanup — calling `handle.revoke()` on unmount
 * frees the object URL.
 *
 * State model:
 * - empty / absolute src → handled purely in render, no state or effect needed
 * - relative src → useEffect fetches via fileService, stores blob URL handle
 */
function MarkdownImage({ src, alt, basePath }: {
  src?: string;
  alt?: string;
  basePath: string;
}) {
  // Classify src type on every render (derived, not state)
  const srcType: 'empty' | 'absolute' | 'relative' =
    !src ? 'empty' : isAbsoluteUrl(src) ? 'absolute' : 'relative';

  const fileService = useWorkspaceFileService(basePath || null);

  // State only needed for async-loaded relative paths
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only relative paths need async loading
    if (srcType !== 'relative') return;
    if (!fileService.isAvailable) return;

    // Decode first to prevent double-encoding (e.g. "some%20image.png")
    const decoded = safeDecodeURIComponent(src!);
    const resolvedPath = resolveRelativePath(basePath, decoded);
    let cancelled = false;
    let handle: { blobUrl: string; revoke: () => void } | null = null;

    (async () => {
      try {
        handle = await fileService.readFileAsBlobUrl({ path: resolvedPath });
        if (cancelled) {
          handle.revoke();
          return;
        }
        setBlobUrl(handle.blobUrl);
      } catch {
        if (!cancelled) setError(`图片加载失败: ${src}`);
      }
    })();

    return () => {
      cancelled = true;
      // The handle owns the blob URL — revoke through it so we don't leak if
      // we created it before the cancel flag flipped.
      if (handle) handle.revoke();
      setBlobUrl(null);
      setError(null);
    };
  }, [src, srcType, basePath, fileService]);

  // Empty src: static error (no state needed)
  if (srcType === 'empty') {
    return <span className="text-xs text-[var(--ink-muted)] italic">[图片路径为空]</span>;
  }

  // Absolute URL: render directly (no state needed, always fresh from props)
  if (srcType === 'absolute') {
    return <img src={src} alt={alt ?? ''} className="max-w-full" />;
  }

  // Relative path: loading / error / loaded
  if (error) {
    return <span className="text-xs text-[var(--ink-muted)] italic">[{error}]</span>;
  }

  if (!blobUrl) {
    return <span className="inline-block h-4 w-16 animate-pulse rounded bg-[var(--paper-inset)]" />;
  }

  return <img src={blobUrl} alt={alt ?? ''} className="max-w-full" />;
}

/**
 * Convert YAML frontmatter (---\n...\n---) to a fenced yaml code block
 * so the existing CodeBlock component renders it with syntax highlighting.
 * Only applied in raw/file-preview mode where skill/agent .md files are displayed.
 */
function convertFrontmatter(content: string): string {
  if (!content) return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return content;
  const yamlBlock = '```yaml\n' + match[1] + '\n```\n';
  return yamlBlock + content.slice(match[0].length);
}

const Markdown = memo(function Markdown({ children, compact = false, preserveNewlines = false, raw = false, basePath }: MarkdownProps) {
  // Skip preprocessing for raw mode (file preview) - preprocessing is for streaming chat messages
  // In raw mode, convert YAML frontmatter to a fenced code block for proper rendering
  const processedContent = raw ? convertFrontmatter(children) : preprocessMarkdownContent(children);

  // Phase D.5: image loading goes through Rust workspace_files (the
  // MarkdownImage component instantiates its own `useWorkspaceFileService`),
  // so the legacy tabId / sidecar `proxyFetch` plumbing is gone.

  // Merge img handler when basePath is provided (for resolving relative image paths)
  // Use == null to allow empty string basePath (root-level files)
  const components = useMemo(() => {
    if (basePath == null) return markdownComponents;
    return {
      ...markdownComponents,
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <MarkdownImage src={props.src} alt={props.alt} basePath={basePath} />
      ),
    };
  }, [basePath]);

  return (
    <div className={`break-words ${compact ? 'text-sm' : 'text-base'}`}>
      <ReactMarkdown
        remarkPlugins={preserveNewlines ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS_DEFAULT}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
