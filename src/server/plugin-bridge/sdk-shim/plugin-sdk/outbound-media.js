// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./outbound-media.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim for openclaw/plugin-sdk/outbound-media.
// Source of truth: openclaw/src/plugin-sdk/outbound-media.ts (upstream)
//
// The upstream implementation is `loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions(...))`,
// which carries SSRF guards, image optimization, MIME sniffing, and kind classification we
// don't need at the bridge surface. Plugin callers (e.g. @wecom/wecom-openclaw-plugin's
// media-uploader.js) detect MIME from magic bytes themselves and only require `{ buffer,
// contentType?, fileName? }`. So this shim implements a minimal-but-secure version:
//
//   - http(s)://...  → fetch + buffer
//   - file://... or absolute path → read disk, validated against mediaLocalRoots
//   - relative path / data: / other schemes → reject
//
// SECURITY: when callers pass mediaLocalRoots, we enforce the path falls under one of those
// roots after symlink resolution (mirrors lark plugin's validateLocalMediaRoots). When the
// caller omits mediaLocalRoots we deny local reads — the bridge wrapper at index.ts always
// scopes to a fresh temp dir, so any caller without a localRoots policy is unsafe.

import { readFile, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const _warned = new Set();
function _warn(msg) {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  console.warn(`[sdk-shim/outbound-media] ${msg}`);
}

/**
 * Resolve `filePath` to a real (symlink-followed) absolute path.
 * Falls back to `path.resolve(filePath)` when realpath fails (e.g. file doesn't exist yet —
 * the subsequent `readFile` will surface a clearer error).
 */
async function resolveRealPath(filePath) {
  const absolute = path.resolve(filePath);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Validate that `filePath` is under one of `localRoots` after symlink resolution.
 * Throws on violation. No-op when `localRoots === 'any'`. Empty array = explicit deny-all.
 *
 * Mirrors the lark plugin's published validateLocalMediaRoots semantics so behavior is
 * uniform across plugin paths.
 */
async function assertLocalRootsAllow(filePath, localRoots) {
  if (localRoots === 'any') return;
  if (!Array.isArray(localRoots)) {
    throw new Error(
      `[outbound-media] Local file access denied for "${filePath}": mediaLocalRoots is not configured. ` +
        `Pass mediaLocalRoots (a non-empty array of allowed root directories) or "any" to opt out of validation.`,
    );
  }
  if (localRoots.length === 0) {
    throw new Error(
      `[outbound-media] Local file access denied for "${filePath}": mediaLocalRoots is an empty array, which blocks all local access.`,
    );
  }
  const resolvedFile = await resolveRealPath(filePath);
  for (const root of localRoots) {
    const resolvedRoot = await resolveRealPath(root);
    // Reject filesystem root entries (POSIX `/`, Windows `C:\`) — they would
    // pass the prefix check below for ANY file and effectively bypass the
    // allowlist. Mirrors upstream openclaw's assertLocalMediaAllowed.
    const parsed = path.parse(resolvedRoot);
    if (resolvedRoot === parsed.root) {
      throw new Error(
        `[outbound-media] mediaLocalRoots entry "${root}" resolves to the filesystem root "${parsed.root}", ` +
          `which is equivalent to "any". Specify a concrete directory or pass mediaLocalRoots: "any" explicitly.`,
      );
    }
    if (resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }
  throw new Error(
    `[outbound-media] Local file access denied for "${filePath}": ` +
      `path is not under any allowed mediaLocalRoots (${localRoots.join(', ')}).`,
  );
}

/**
 * Load outbound media from a URL or local path.
 *
 * Contract matches openclaw/plugin-sdk/outbound-media.ts:loadOutboundMediaFromUrl:
 *   @param mediaUrl    - http(s):// URL, file:// URL, or absolute filesystem path.
 *   @param options     - { maxBytes?, mediaLocalRoots?, fetchImpl?, requestInit? }
 *   @returns           - { buffer: Buffer, contentType?: string, fileName?: string }
 *
 * Note: this shim deliberately omits the upstream's image optimization, MIME sniffing,
 * SSRF policy, and kind classification — plugins that consume this function (e.g. wecom)
 * either detect MIME themselves or accept `application/octet-stream` as fallback.
 */
export async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
  if (typeof mediaUrl !== 'string' || mediaUrl.length === 0) {
    throw new Error('[outbound-media] mediaUrl is required');
  }

  const maxBytes = options.maxBytes;
  const mediaLocalRoots = options.mediaLocalRoots ?? options.mediaAccess?.localRoots;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestInit = options.requestInit;

  // ----- Remote URL path -----
  if (/^https?:\/\//i.test(mediaUrl)) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('[outbound-media] fetch is not available in this runtime');
    }
    const resp = await fetchImpl(mediaUrl, requestInit);
    if (!resp.ok) {
      throw new Error(`[outbound-media] Failed to fetch ${mediaUrl}: HTTP ${resp.status}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (typeof maxBytes === 'number' && buffer.length > maxBytes) {
      throw new Error(
        `[outbound-media] Remote media exceeds maxBytes (${buffer.length} > ${maxBytes})`,
      );
    }
    let fileName;
    try {
      fileName = path.basename(new URL(mediaUrl).pathname) || undefined;
    } catch {
      fileName = undefined;
    }
    return {
      buffer,
      contentType: resp.headers.get('content-type') ?? undefined,
      fileName,
    };
  }

  // ----- Local path: file:// URL or bare absolute path -----
  let filePath;
  if (mediaUrl.startsWith('file://')) {
    try {
      filePath = fileURLToPath(mediaUrl);
    } catch (err) {
      throw new Error(`[outbound-media] Invalid file:// URL: ${mediaUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (path.isAbsolute(mediaUrl)) {
    filePath = mediaUrl;
  } else {
    // Relative paths, data: URLs, and other schemes are not supported in the shim.
    // The upstream resolves relative paths against `workspaceDir`, but Bridge plugins
    // don't have a workspaceDir, so fail loud rather than silently.
    throw new Error(
      `[outbound-media] Unsupported mediaUrl: ${mediaUrl} (only http(s)://, file://, and absolute paths are supported)`,
    );
  }

  await assertLocalRootsAllow(filePath, mediaLocalRoots);

  // Statting first gives a clearer error surface than letting readFile throw on a directory.
  const stats = await stat(filePath).catch((err) => {
    throw new Error(`[outbound-media] Cannot stat "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!stats.isFile()) {
    throw new Error(`[outbound-media] Path is not a regular file: ${filePath}`);
  }
  if (typeof maxBytes === 'number' && stats.size > maxBytes) {
    throw new Error(`[outbound-media] Local media exceeds maxBytes (${stats.size} > ${maxBytes})`);
  }

  const buffer = await readFile(filePath);
  if (typeof maxBytes === 'number' && buffer.length > maxBytes) {
    // Defensive — stats.size and actual buffer length should agree, but the file may have
    // grown between stat and read.
    throw new Error(`[outbound-media] Local media exceeds maxBytes (${buffer.length} > ${maxBytes})`);
  }

  return {
    buffer,
    fileName: path.basename(filePath) || undefined,
  };
}

// Upstream exports a single function. If the SDK adds peers in future versions, callers
// importing them will land on these stubs and get the warning so the gap is visible.
export function buildOutboundMediaLoadOptions(params = {}) {
  _warn('buildOutboundMediaLoadOptions() is a passthrough in Bridge mode');
  return params ?? {};
}
