/**
 * SDK Shim Stub Generator
 *
 * Reads the OpenClaw source tree and generates safe stub files for every
 * `plugin-sdk/*` subpath export that does not already have a hand-written
 * shim.  This prevents "Cannot find module" / "does not provide an export
 * named X" crashes when plugins import modules — or *exports of modules* —
 * we haven't manually implemented.
 *
 * Two file modes for each `plugin-sdk/<name>`:
 *   1. Auto-generated stub file (`<name>.js`)  — when <name> is NOT in
 *      `_handwritten.json`. The generator rebuilds these wholesale.
 *   2. Handwritten file (`<name>.js`)          — when <name> IS in
 *      `_handwritten.json`. The generator never overwrites the file's body,
 *      but it DOES emit a sibling `<name>.auto.js` containing safe-default
 *      stubs for every upstream value export, and idempotently injects
 *      `export * from "./<name>.auto.js"` into the handwritten file (inside
 *      a marked block at the top). ESM `export *` is silently shadowed by
 *      direct local exports, so handwritten implementations always win for
 *      names they own. Names the handwritten file does *not* own fall
 *      through to the auto stubs instead of producing a SyntaxError at
 *      module-link time. This is the structural fix for the recurring
 *      "openclaw/plugin-sdk/X does not provide export Y" bug class
 *      (#171 → #180 → #187).
 *
 * Run via `npm run generate:sdk-shims` (which expands to
 * `node --import tsx/esm scripts/generate-sdk-shims.ts`). No shebang on
 * this file: the script isn't `chmod +x`'d in the repo and the v0.2.0
 * runtime is bundled Node, not Bun.
 *
 * Usage:
 *   npm run generate:sdk-shims                                  # default
 *   npm run generate:sdk-shims -- --openclaw-dir ../oc          # custom path
 *   npm run generate:sdk-shims -- --dry-run                     # preview only
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");

let openclawDir = path.resolve(process.cwd(), "../openclaw");
const dirIdx = args.indexOf("--openclaw-dir");
if (dirIdx !== -1 && args[dirIdx + 1]) {
  openclawDir = path.resolve(args[dirIdx + 1]);
}

const SHIM_DIR = path.resolve(
  process.cwd(),
  "src/server/plugin-bridge/sdk-shim",
);
const PLUGIN_SDK_DIR = path.join(SHIM_DIR, "plugin-sdk");
const HANDWRITTEN_PATH = path.join(PLUGIN_SDK_DIR, "_handwritten.json");

// ---------------------------------------------------------------------------
// Validate inputs
// ---------------------------------------------------------------------------

const openclawPkgPath = path.join(openclawDir, "package.json");
if (!fs.existsSync(openclawPkgPath)) {
  console.error(`❌ OpenClaw package.json not found at: ${openclawPkgPath}`);
  console.error(
    `   Use --openclaw-dir to specify the openclaw source directory.`,
  );
  process.exit(1);
}

if (!fs.existsSync(HANDWRITTEN_PATH)) {
  console.error(`❌ _handwritten.json not found at: ${HANDWRITTEN_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------

const openclawPkg = JSON.parse(fs.readFileSync(openclawPkgPath, "utf8"));
const handwritten: string[] = JSON.parse(
  fs.readFileSync(HANDWRITTEN_PATH, "utf8"),
);
const handwrittenSet = new Set(handwritten);

// Extract all ./plugin-sdk/* export paths
const allExports: string[] = Object.keys(openclawPkg.exports || {})
  .filter((k: string) => k.startsWith("./plugin-sdk"))
  .map((k: string) => {
    const name = k.replace("./plugin-sdk/", "").replace("./plugin-sdk", "index");
    return name;
  });

console.log(`📦 OpenClaw exports: ${allExports.length}`);
console.log(`✋ Hand-written shims: ${handwrittenSet.size}`);
console.log(`🔧 To generate: ${allExports.length - handwrittenSet.size}`);
console.log(`📂 OpenClaw source: ${openclawDir}`);
if (dryRun) console.log(`🏃 DRY RUN — no files will be written\n`);
else console.log();

// ---------------------------------------------------------------------------
// Export symbol extraction
// ---------------------------------------------------------------------------

interface ExportSymbol {
  name: string;
  kind: "function" | "async-function" | "class" | "const" | "enum";
}

/** Cache to avoid re-parsing the same file */
const extractCache = new Map<string, ExportSymbol[]>();

/**
 * Resolve an import specifier relative to the importing file.
 * Handles the TypeScript convention: `import from "../foo.js"` → `../foo.ts`
 */
function resolveImportPath(
  fromFile: string,
  specifier: string,
): string | null {
  const dir = path.dirname(fromFile);
  const base = path.join(dir, specifier);

  // Try .ts first (TS convention: imports use .js but files are .ts)
  const tsPath = base.replace(/\.js$/, ".ts");
  if (fs.existsSync(tsPath)) return tsPath;

  // Try .ts if no extension
  if (!path.extname(base) && fs.existsSync(base + ".ts")) return base + ".ts";

  // Try the literal path
  if (fs.existsSync(base)) return base;

  // Try index.ts
  if (fs.existsSync(path.join(base, "index.ts")))
    return path.join(base, "index.ts");

  return null;
}

/**
 * Find every `export { ... }` and `export type { ... }` block in TS/JS
 * source. Returns the body (between the braces) with comments stripped,
 * plus an `isTypeOnly` flag so callers can skip type-only blocks.
 *
 * Hand-rolled rather than regex because the prior regex
 * `^export\s+\{([^}]+)\}/gm` was wrong: `[^}]+` stops at the FIRST `}`,
 * including ones that live inside `//` line comments and `/* * /` block
 * comments inside the export list. Upstream openclaw's channel-inbound.ts
 * has:
 *
 *   export {
 *     // @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`.
 *     resolveMentionGatingWithBypass,
 *   } from "...";
 *
 * The regex matched up to the `}` after `policy` and synthesized a fake
 * `policy` export from the comment text, while silently dropping
 * `resolveMentionGatingWithBypass`. yuanbao v2.13.2 then failed ESM link
 * with "does not provide an export named 'resolveMentionGatingWithBypass'"
 * (issue #202). The same trap fires for channel-mention-gating.ts and
 * config-runtime.ts; a future deprecation comment with `}` inside any
 * export block would silently break shim generation again.
 *
 * The scanner: locate `^export(\s+type)?\s+\{`, then walk forward
 * tracking depth, skipping comment regions and string literals so braces
 * inside them don't count. Return the body with comments stripped so a
 * downstream split on `,` produces clean identifier candidates.
 */
function findNamedExportBlocks(
  src: string,
): Array<{ body: string; isTypeOnly: boolean }> {
  const blocks: Array<{ body: string; isTypeOnly: boolean }> = [];
  const headRe = /^export(\s+type)?\s+\{/gm;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(src)) !== null) {
    const isTypeOnly = !!m[1];
    const bodyStart = headRe.lastIndex; // index after the opening `{`
    let i = bodyStart;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      const n = src[i + 1];
      // // line comment → skip to end of line
      if (c === "/" && n === "/") {
        const nl = src.indexOf("\n", i);
        i = nl === -1 ? src.length : nl + 1;
        continue;
      }
      // /* block comment */ → skip to */
      if (c === "/" && n === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }
      // string / template literal → skip past matching quote
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const body = src
            .slice(bodyStart, i)
            // belt-and-suspenders: also strip comments from the captured
            // body so the downstream `split(",")` doesn't see fragments
            // like `// @deprecated Prefer (` as an identifier
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*$/gm, "");
          blocks.push({ body, isTypeOnly });
          // advance headRe past the closing brace before continuing
          headRe.lastIndex = i + 1;
          break;
        }
      }
      i++;
    }
    // If we walked off the end without closing (malformed source), drop
    // this block and end the loop — there are no further `export {` heads
    // to find past EOF.
    if (depth > 0) headRe.lastIndex = src.length;
  }
  return blocks;
}

/**
 * Extract all value (non-type) exported symbols from a TypeScript file.
 * Recursively follows `export * from` up to maxDepth.
 */
function extractExports(filePath: string, depth: number = 0): ExportSymbol[] {
  if (depth > 5) return [];
  if (extractCache.has(filePath)) return extractCache.get(filePath)!;

  // Put empty array in cache first to break circular references
  extractCache.set(filePath, []);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const symbols: ExportSymbol[] = [];
  const seen = new Set<string>();

  const add = (sym: ExportSymbol) => {
    if (!seen.has(sym.name)) {
      seen.add(sym.name);
      symbols.push(sym);
    }
  };

  // --- Direct exports ---

  // export function NAME / export async function NAME
  for (const m of content.matchAll(
    /^export\s+async\s+function\s+(\w+)/gm,
  )) {
    add({ name: m[1], kind: "async-function" });
  }
  for (const m of content.matchAll(
    /^export\s+function\s+(\w+)/gm,
  )) {
    add({ name: m[1], kind: "function" });
  }

  // export class NAME
  for (const m of content.matchAll(/^export\s+class\s+(\w+)/gm)) {
    add({ name: m[1], kind: "class" });
  }

  // export const/let NAME
  for (const m of content.matchAll(/^export\s+(?:const|let)\s+(\w+)/gm)) {
    add({ name: m[1], kind: "const" });
  }

  // export enum NAME
  for (const m of content.matchAll(/^export\s+enum\s+(\w+)/gm)) {
    add({ name: m[1], kind: "enum" });
  }

  // --- Named exports: export { A, B } from "..." AND local export { A, B };
  // Must skip type-only: export type { A } from "..." / export type { A };
  // And skip individual `type X` within mixed export blocks.
  //
  // Use a comment/string-aware brace matcher rather than a `[^}]+` regex —
  // see findNamedExportBlocks() for the bug #202 history (JSDoc `}` inside
  // a deprecation comment truncated the export block and synthesized a
  // bogus `policy` export, breaking yuanbao plugin load).
  for (const block of findNamedExportBlocks(content)) {
    if (block.isTypeOnly) continue;
    for (const part of block.body.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Skip `type Foo` within a mixed export block
      if (/^type\s+/.test(trimmed)) continue;

      // Handle `foo as bar` → exported name is `bar`
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      const name = asMatch ? asMatch[2] : trimmed.match(/^(\w+)/)?.[1];
      if (name) {
        // Heuristic: const if ALL_UPPER_SNAKE, OR PascalCase ending in a
        // noun-shaped suffix (Schema/Config/Defaults/Pattern). camelCase
        // names — including `xxxForConfig` / `xxxBySchema` action verbs —
        // are ALWAYS functions. Misclassifying `listChatCommandsForConfig`
        // as a const broke yuanbao v2.13.1 (issue #187) because the
        // resulting `export const listChatCommandsForConfig = undefined`
        // turned the plugin's `listChatCommandsForConfig(cfg)` call into a
        // TypeError at runtime instead of a no-op `[]` return.
        const isUpperSnake = /^[A-Z_][A-Z0-9_]*$/.test(name);
        const isPascalNounSuffix =
          /^[A-Z]/.test(name) && /(Schema|Config|Defaults|Pattern)$/.test(name);
        const isConst = isUpperSnake || isPascalNounSuffix;
        const kind = isConst ? "const" : "function";
        add({ name, kind: kind as ExportSymbol["kind"] });
      }
    }
  }

  // --- Star re-exports: export * from "..." ---
  // NOT: export type * from "..."
  for (const m of content.matchAll(
    /^export\s+\*\s+from\s+["']([^"']+)["']/gm,
  )) {
    // Check it's not `export type * from`
    const lineStart = content.lastIndexOf("\n", (m.index ?? 0)) + 1;
    const linePrefix = content.slice(lineStart, m.index ?? 0);
    if (/type\s*$/.test(linePrefix)) continue;

    const targetPath = resolveImportPath(filePath, m[1]);
    if (targetPath) {
      for (const sym of extractExports(targetPath, depth + 1)) {
        add(sym);
      }
    } else if (verbose) {
      console.warn(
        `  ⚠️  Cannot resolve: export * from "${m[1]}" in ${path.relative(openclawDir, filePath)}`,
      );
    }
  }

  extractCache.set(filePath, symbols);
  return symbols;
}

// ---------------------------------------------------------------------------
// Handwritten-file inspection (for drift-stub augmentation)
// ---------------------------------------------------------------------------

/**
 * Read value-export names a handwritten shim file makes visible — direct
 * exports plus everything reachable through its existing `export * from`
 * chains.
 *
 * Two reasons to walk wildcard chains, not just direct exports:
 *
 *   1. Correctness — star-vs-star is ambiguous. If the handwritten file
 *      already does `export * from "./index.js"` and `./index.js` exports
 *      `fooBar`, and our new `<name>.auto.js` also exports `fooBar` via
 *      another `export *`, the resulting compat module has TWO wildcard
 *      re-exports for the same name. ESM ResolveExport returns "ambiguous"
 *      and Node throws `SyntaxError: ... contains conflicting star exports
 *      for name 'fooBar'` at link time on any named import. This regressed
 *      compat.js in the first cut of this fix (caught by Codex review).
 *   2. Hygiene — only emit auto stubs for names the handwritten file does
 *      not yet provide, so the auto file stays small and `_w()` warnings
 *      only fire for names that genuinely lack a real implementation.
 *
 * NOTE: For LOCAL+star conflicts (a handwritten direct export with the same
 * name as an auto-stub), the direct local export shadows the wildcard per
 * ESM spec, so chain-walking is not strictly needed there. We do it anyway
 * for cleanliness. The star-vs-star case is the load-bearing one.
 */
function extractHandwrittenExports(
  src: string,
  fromDir: string,
  visited: Set<string> = new Set(),
): Set<string> {
  const names = new Set<string>();

  // export function/async function/class/enum/const/let NAME
  for (const m of src.matchAll(
    /^export\s+(?:async\s+function|function|class|enum|const|let)\s+(\w+)/gm,
  )) {
    names.add(m[1]);
  }
  // export { A, B } / export { A, B } from "..."
  // Comment/string-aware brace matcher — see findNamedExportBlocks() for
  // why a regex won't do (bug #202: JSDoc with `}` inside the export block
  // truncated the parse).
  for (const block of findNamedExportBlocks(src)) {
    if (block.isTypeOnly) continue;
    for (const part of block.body.split(",")) {
      const t = part.trim();
      if (!t || /^type\s+/.test(t)) continue;
      const asMatch = t.match(/(\w+)\s+as\s+(\w+)/);
      const name = asMatch ? asMatch[2] : t.match(/^(\w+)/)?.[1];
      if (name) names.add(name);
    }
  }

  // export * from "./X.js" — follow the chain (relative paths only, ignore
  // bare specifiers since those resolve to npm packages we don't control).
  for (const m of src.matchAll(/^export\s+\*\s+from\s+["'](\.[^"']+)["']/gm)) {
    const spec = m[1].replace(/\.js$/, "");
    const target = path.resolve(fromDir, spec + ".js");
    if (visited.has(target)) continue;
    visited.add(target);
    if (!fs.existsSync(target)) continue;
    const childSrc = fs.readFileSync(target, "utf8");
    for (const n of extractHandwrittenExports(
      childSrc,
      path.dirname(target),
      visited,
    )) {
      names.add(n);
    }
  }

  return names;
}

/**
 * Strip `export const X = undefined;` placeholder lines from a handwritten
 * shim file. These were a previous-generation band-aid: when an upstream
 * export was missing from the shim, a maintainer would manually add
 * `export const NAME = undefined;` to silence the ESM link error,
 * leaving the call site to TypeError at runtime instead.
 *
 * Once auto-augment is in place, those placeholders are actively harmful:
 * the handwritten direct export still shadows the wildcard `export *` from
 * the sibling auto file, so the placeholder wins and the auto-stub
 * (a callable function returning a safe default) never takes effect. Calls
 * keep crashing with "X is not a function" even though the auto file
 * provides a working stub.
 *
 * Strip them so the auto-stub wins. Returns the cleaned source and the list
 * of names removed (for the run summary).
 */
function stripPlaceholderConsts(src: string): { stripped: string; removed: string[] } {
  const removed: string[] = [];
  const stripped = src.replace(
    /^export\s+const\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*undefined\s*;\s*\n/gm,
    (_match, name) => {
      removed.push(name);
      return "";
    },
  );
  return { stripped, removed };
}

const AUGMENT_BEGIN = "// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===";
const AUGMENT_END = "// === END AUTO-AUGMENT ===";

/**
 * Idempotently insert the `export * from "./<name>.auto.js"` line into a
 * handwritten shim file, wrapped in marker comments so subsequent runs
 * detect and skip re-insertion.
 *
 * The block is inserted at the very top so a casual reader immediately sees
 * "this file gets drift stubs from a sibling". Direct local exports below
 * still shadow the wildcard re-export per ESM spec — see the test in
 * /tmp/esm-test that verified this behavior before this change landed.
 */
function ensureAugmentLine(src: string, moduleName: string): string {
  if (src.includes(AUGMENT_BEGIN)) return src;
  const block = [
    AUGMENT_BEGIN,
    `// Stubs for upstream openclaw exports the handwritten file below does not`,
    `// implement. Regenerate via: npm run generate:sdk-shims`,
    `export * from "./${moduleName}.auto.js";`,
    AUGMENT_END,
    "",
    "",
  ].join("\n");
  return block + src;
}

// ---------------------------------------------------------------------------
// Stub rendering
// ---------------------------------------------------------------------------

/** Heuristic return value based on function name */
function inferReturnValue(name: string): string {
  // Boolean predicates
  if (/^(is|has|should|can|was|did|does|needs|supports)[A-Z]/.test(name))
    return "false";
  // List/collection builders
  if (/^(list|collect|get\w*Entries|get\w*Items|find\w*All)/.test(name))
    return "[]";
  // String formatters
  if (/^(format|normalize|strip|sanitize|encode|decode|serialize)/.test(name))
    return '""';
  // Default
  return "undefined";
}

function renderStub(moduleName: string, symbols: ExportSymbol[]): string {
  const lines: string[] = [];

  lines.push(`// AUTO-GENERATED STUB — do not edit manually.`);
  lines.push(`// Regenerate: npm run generate:sdk-shims`);
  lines.push(`// Source: openclaw/src/plugin-sdk/${moduleName}.ts`);
  lines.push(``);

  if (symbols.length === 0) {
    lines.push(`// Type-only module or no extractable runtime exports.`);
    lines.push(`export {};`);
    lines.push(``);
    return lines.join("\n");
  }

  // Warning helper
  lines.push(`const _warned = new Set();`);
  lines.push(`function _w(fn) {`);
  lines.push(
    `  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/${moduleName}.' + fn + '() not implemented in Bridge mode'); }`,
  );
  lines.push(`}`);
  lines.push(``);

  // Render each symbol with `export` prefix (ESM — package is "type": "module")
  for (const sym of symbols) {
    switch (sym.kind) {
      case "function": {
        const ret = inferReturnValue(sym.name);
        lines.push(
          `export function ${sym.name}() { _w('${sym.name}'); return ${ret}; }`,
        );
        break;
      }
      case "async-function": {
        const ret = inferReturnValue(sym.name);
        lines.push(
          `export async function ${sym.name}() { _w('${sym.name}'); return ${ret}; }`,
        );
        break;
      }
      case "class":
        lines.push(
          `export class ${sym.name} { constructor() { _w('${sym.name}'); } }`,
        );
        break;
      case "const":
        lines.push(`export const ${sym.name} = undefined;`);
        break;
      case "enum":
        lines.push(`export const ${sym.name} = Object.freeze({});`);
        break;
    }
  }
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Package.json update
// ---------------------------------------------------------------------------

function buildExportsMap(moduleNames: string[]): Record<string, string> {
  const exports: Record<string, string> = {};
  for (const name of moduleNames) {
    const key = name === "index" ? "./plugin-sdk" : `./plugin-sdk/${name}`;
    exports[key] = `./plugin-sdk/${name}.js`;
  }
  return exports;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let generated = 0;
let augmented = 0;
let skipped = 0;
let warnings = 0;

for (const moduleName of allExports) {
  // Hand-written modules: do NOT overwrite the body. Instead, emit a
  // sibling `<name>.auto.js` with stubs for every upstream value export,
  // then idempotently inject `export * from "./<name>.auto.js"` into the
  // handwritten file. ESM rules silently shadow `export *` re-exports by
  // direct local exports, so the handwritten implementations stay
  // authoritative while *new* upstream exports get safe-default fallbacks
  // automatically — closes the recurring "X does not provide export Y"
  // bug class (#171 → #180 → #187).
  if (handwrittenSet.has(moduleName)) {
    const srcPath = path.join(openclawDir, "src/plugin-sdk", `${moduleName}.ts`);
    const handwrittenFile = path.join(PLUGIN_SDK_DIR, `${moduleName}.js`);

    // Custom hand-written module with no upstream counterpart (e.g. `compat`).
    // No auto-augment needed; pass through.
    if (!fs.existsSync(srcPath) || !fs.existsSync(handwrittenFile)) {
      skipped++;
      if (verbose) console.log(`  ✋ ${moduleName} (hand-written, no upstream — skip augment)`);
      continue;
    }

    const upstreamSymbols = extractExports(srcPath);
    const rawHandwrittenSrc = fs.readFileSync(handwrittenFile, "utf8");
    const { stripped: handwrittenSrc, removed: strippedPlaceholders } =
      stripPlaceholderConsts(rawHandwrittenSrc);
    // Pre-seed `visited` with the module's OWN auto.js path so the chain
    // walk doesn't count "names the auto file will export" as already
    // covered — that would be circular: we're about to write that file
    // based on what's NOT yet covered. Without this, command-auth.js's
    // `export * from "./command-auth.auto.js"` augment line would lead the
    // walk to believe listChatCommandsForConfig is covered, and the
    // freshly-written auto file would then omit it, leaving the export
    // resolving to undefined.
    const ownAutoPath = path.join(PLUGIN_SDK_DIR, `${moduleName}.auto.js`);
    const handwrittenNames = extractHandwrittenExports(
      handwrittenSrc,
      PLUGIN_SDK_DIR,
      new Set([ownAutoPath]),
    );

    if (strippedPlaceholders.length > 0 && verbose) {
      console.log(
        `  🧹 ${moduleName}: stripped ${strippedPlaceholders.length} placeholder consts (${strippedPlaceholders.slice(0, 3).join(", ")}${strippedPlaceholders.length > 3 ? "…" : ""})`,
      );
    }

    // Only emit stubs for upstream symbols NOT already exported by hand.
    // Belt-and-suspenders: even if upstream and handwritten overlap, ESM
    // resolves the local export first, but emitting only the diff keeps
    // the auto file small and the warning surface minimal.
    const missingSymbols = upstreamSymbols.filter(
      (s) => !handwrittenNames.has(s.name),
    );

    const autoPath = path.join(PLUGIN_SDK_DIR, `${moduleName}.auto.js`);
    const autoContent = renderStub(moduleName, missingSymbols);

    if (verbose) {
      console.log(
        `  🩹 ${moduleName}: ${handwrittenNames.size} handwritten + ${missingSymbols.length} auto-augmented (${upstreamSymbols.length} upstream total)`,
      );
    }

    if (!dryRun) {
      fs.writeFileSync(autoPath, autoContent);
      const next = ensureAugmentLine(handwrittenSrc, moduleName);
      // Always write if we stripped placeholders OR injected the augment
      // line. Comparing against `rawHandwrittenSrc` rather than the post-
      // strip `handwrittenSrc` ensures placeholder removal is persisted
      // even when the augment line was already present.
      if (next !== rawHandwrittenSrc) {
        fs.writeFileSync(handwrittenFile, next);
      }
    }

    augmented++;
    continue;
  }

  // Safety: if file exists but is NOT in handwritten manifest and NOT auto-generated, warn
  const targetFile = path.join(PLUGIN_SDK_DIR, `${moduleName}.js`);
  if (fs.existsSync(targetFile)) {
    const header = fs.readFileSync(targetFile, "utf8").slice(0, 100);
    if (!header.includes("AUTO-GENERATED STUB")) {
      console.warn(
        `  ⚠️  ${moduleName}.js exists but is NOT in _handwritten.json and has no auto-gen header. Skipping to be safe — add it to _handwritten.json if intentional.`,
      );
      warnings++;
      continue;
    }
  }

  // Read OpenClaw source
  const srcPath = path.join(openclawDir, "src/plugin-sdk", `${moduleName}.ts`);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠️  Source not found: ${srcPath}`);
    warnings++;
    // Generate empty stub anyway
    const stub = renderStub(moduleName, []);
    if (!dryRun) {
      fs.writeFileSync(path.join(PLUGIN_SDK_DIR, `${moduleName}.js`), stub);
    }
    generated++;
    continue;
  }

  // Extract symbols
  const symbols = extractExports(srcPath);

  if (verbose) {
    console.log(
      `  🤖 ${moduleName}: ${symbols.length} symbols (${symbols.map((s) => s.name).join(", ")})`,
    );
  }

  // Render and write stub
  const stub = renderStub(moduleName, symbols);

  if (!dryRun) {
    fs.writeFileSync(path.join(PLUGIN_SDK_DIR, `${moduleName}.js`), stub);
  }

  generated++;
}

// Update package.json
const shimPkgPath = path.join(SHIM_DIR, "package.json");
const shimPkg = JSON.parse(fs.readFileSync(shimPkgPath, "utf8"));

// Update version to today's date.
// Per CLAUDE.md red line "Plugin Bridge / 修改 SDK shim MUST 三处同步 bump 版本"
// the same date must appear in three places:
//   1. sdk-shim/package.json (with "-shim" suffix, used as the runtime
//      freshness probe in src-tauri/src/im/bridge.rs::needs_repair)
//   2. src/server/plugin-bridge/compat-runtime.ts::SHIM_COMPAT_VERSION
//      (returned to plugins as api.runtime.version for assertHostCompatibility)
//   3. src-tauri/src/im/bridge.rs::SHIM_COMPAT_VERSION
//      (compared against installed shim version to trigger re-install)
// Skipping any one of the three either ships a stale shim or causes
// bridge integrity checks to fail. Centralizing it here makes the
// rule pit-of-success rather than a footgun.
const now = new Date();
const dateStr = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
shimPkg.version = `${dateStr}-shim`;

// Build complete exports map: OpenClaw exports + any extra hand-written modules
// (e.g., `compat` is our custom module not in OpenClaw's exports)
const allModuleNames = new Set(allExports);
for (const hw of handwritten) {
  const jsFile = path.join(PLUGIN_SDK_DIR, `${hw}.js`);
  if (!allModuleNames.has(hw) && fs.existsSync(jsFile)) {
    allModuleNames.add(hw);
    if (verbose) console.log(`  ➕ ${hw} (custom hand-written, not in OpenClaw)`);
  }
}
const sortedModules = [...allModuleNames].sort((a, b) => {
  // index always first
  if (a === "index") return -1;
  if (b === "index") return 1;
  return a.localeCompare(b);
});
shimPkg.exports = buildExportsMap(sortedModules);

if (!dryRun) {
  fs.writeFileSync(shimPkgPath, JSON.stringify(shimPkg, null, 2) + "\n");
}

// Propagate the version into the two other places mandated by the
// "三处同步 bump" red line. Both files store the bare date (no "-shim"
// suffix); only the package.json carries that suffix.
const compatRuntimePath = path.resolve(
  process.cwd(),
  "src/server/plugin-bridge/compat-runtime.ts",
);
const bridgeRsPath = path.resolve(
  process.cwd(),
  "src-tauri/src/im/bridge.rs",
);

function bumpVersionConst(
  filePath: string,
  pattern: RegExp,
  newVersion: string,
): "updated" | "unchanged" | "missing" {
  if (!fs.existsSync(filePath)) return "missing";
  const before = fs.readFileSync(filePath, "utf8");
  const after = before.replace(pattern, (match) => {
    const quote = match.includes('"') ? '"' : "'";
    return match.replace(/['"][^'"]+['"]/, `${quote}${newVersion}${quote}`);
  });
  if (before === after) return "unchanged";
  if (!dryRun) fs.writeFileSync(filePath, after);
  return "updated";
}

// compat-runtime.ts:  const SHIM_COMPAT_VERSION = '2026.5.10';
const tsStatus = bumpVersionConst(
  compatRuntimePath,
  /const\s+SHIM_COMPAT_VERSION\s*=\s*['"][^'"]+['"]/,
  dateStr,
);
// bridge.rs:          const SHIM_COMPAT_VERSION: &str = "2026.5.10";
const rsStatus = bumpVersionConst(
  bridgeRsPath,
  /const\s+SHIM_COMPAT_VERSION\s*:\s*&str\s*=\s*"[^"]+"/,
  dateStr,
);

// Summary
const customCount = sortedModules.length - allExports.length;
console.log(`\n✅ Done!`);
console.log(`   Generated:  ${generated} stub files`);
console.log(`   Augmented:  ${augmented} handwritten files (sibling .auto.js)`);
console.log(`   Skipped:    ${skipped} custom hand-written (no upstream)`);
console.log(`   Custom:     ${customCount} hand-written modules not in OpenClaw`);
console.log(`   Warnings:   ${warnings}`);
console.log(`   Exports:    ${sortedModules.length} total in package.json`);
console.log(`   Version:    ${shimPkg.version}`);
console.log(`   compat-runtime.ts SHIM_COMPAT_VERSION → ${dateStr} (${tsStatus})`);
console.log(`   bridge.rs   SHIM_COMPAT_VERSION → ${dateStr} (${rsStatus})`);

if (dryRun) {
  console.log(`\n🏃 This was a dry run. No files were written.`);
} else {
  console.log(`\n📁 Output: ${PLUGIN_SDK_DIR}`);
}
