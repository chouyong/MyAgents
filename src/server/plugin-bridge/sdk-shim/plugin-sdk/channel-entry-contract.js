// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-entry-contract.auto.js";
// === END AUTO-AUGMENT ===

// Hand-written shim for openclaw/plugin-sdk/channel-entry-contract.
//
// The auto-generated stub returned `undefined` from defineBundledChannelEntry,
// so any plugin shipping the 3.x bundled-entry shape (e.g. openclaw-plugin-yuanbao
// 2.13.x — issue #180) had no `register()` for the bridge to call and crashed
// with "Plugin did not register a channel via registerChannel()".
//
// Real openclaw protocol (openclaw/src/plugin-sdk/channel-entry-contract.ts):
//   - defineBundledChannelEntry({
//       id, name, description, importMetaUrl,
//       plugin:  { specifier, exportName },         // lazy ref to channel plugin object
//       runtime: { specifier, exportName }?,        // lazy ref to setRuntime(rt) setter
//       registerFull(api)?,                          // tools/commands/init
//     }) → entry object whose async register(api) loads the declared sidecars,
//     invokes the runtime setter with api.runtime, calls api.registerChannel({plugin}),
//     then runs registerFull(api).
//   - loadBundledEntryExportSync(importMetaUrl, { specifier, exportName }) →
//     sync-loads `specifier` relative to importMetaUrl and returns the named
//     export. Upstream uses createRequire() (Node v24 supports require(esm)
//     for ESM modules with no top-level await), falling back to jiti(). We mirror
//     the createRequire path; that's enough for built JS plugins. registerFull()
//     may legitimately reference sidecars beyond plugin/runtime (Feishu/Slack/
//     Mattermost upstream do), so don't restrict to manifest-declared specs.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Cache module objects keyed by `${importMetaUrl}::${specifier}` so repeated
// loads return the same instance (singletons across registerTools/registerCommands
// calls in the same plugin).
const _moduleCache = new Map();
// One createRequire() per importMetaUrl — cheap to build but pointless to
// rebuild on every loadBundledEntryExportSync call.
const _requireCache = new Map();

function _getRequire(importMetaUrl) {
  if (typeof importMetaUrl !== 'string' || !importMetaUrl.startsWith('file:')) {
    throw new Error(
      `[sdk-shim] channel-entry-contract: importMetaUrl must be a file:// URL, got ${String(importMetaUrl)}`,
    );
  }
  let req = _requireCache.get(importMetaUrl);
  if (!req) {
    // createRequire accepts file:// URLs directly; it anchors module
    // resolution at that file's directory.
    req = createRequire(importMetaUrl);
    _requireCache.set(importMetaUrl, req);
  }
  return req;
}

function _loadModule(importMetaUrl, specifier) {
  const key = `${importMetaUrl}::${specifier}`;
  // Use has() rather than truthiness so falsey CJS exports (`module.exports = 0`)
  // are still cached correctly.
  if (_moduleCache.has(key)) return _moduleCache.get(key);
  const req = _getRequire(importMetaUrl);
  // Resolve to absolute path first so the cache key is canonical even if
  // multiple importers reference the same target via different relative paths.
  const resolved = req.resolve(specifier);
  const canonicalKey = `${importMetaUrl}::${resolved}`;
  let mod;
  if (_moduleCache.has(canonicalKey)) {
    mod = _moduleCache.get(canonicalKey);
  } else {
    mod = req(resolved);
    _moduleCache.set(canonicalKey, mod);
  }
  _moduleCache.set(key, mod);
  return mod;
}

function _readExport(mod, exportName, where) {
  const name = exportName ?? 'default';
  if (mod == null || !(name in mod)) {
    throw new Error(`[sdk-shim] channel-entry-contract: export "${name}" not found in ${where}`);
  }
  return mod[name];
}

export function loadBundledEntryExportSync(importMetaUrl, spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.specifier !== 'string') {
    throw new Error(
      '[sdk-shim] loadBundledEntryExportSync: spec must be { specifier, exportName? }',
    );
  }
  const mod = _loadModule(importMetaUrl, spec.specifier);
  return _readExport(mod, spec.exportName, spec.specifier);
}

function _attachIdName(pluginObj, id, name) {
  if (!pluginObj || typeof pluginObj !== 'object') return pluginObj;
  if (id && !pluginObj.id) pluginObj.id = id;
  if (name && !pluginObj.name) pluginObj.name = name;
  return pluginObj;
}

function _resolveSpecExport(importMetaUrl, spec) {
  if (!spec || typeof spec !== 'object' || typeof spec.specifier !== 'string') return undefined;
  const mod = _loadModule(importMetaUrl, spec.specifier);
  return _readExport(mod, spec.exportName, spec.specifier);
}

export function defineBundledChannelEntry(params) {
  const id = params?.id || 'unknown';
  const name = params?.name || params?.id || 'Unknown';
  return {
    id,
    name,
    description: params?.description || '',
    register(api) {
      // Order matches upstream openclaw/src/plugin-sdk/channel-entry-contract.ts:
      // load plugin → registerChannel → setChannelRuntime → registerFull.
      // The runtime setter runs after registerChannel because upstream profiles
      // it that way and at least one plugin reads the registered channel object
      // back from the api inside its setter.
      if (params?.plugin) {
        const pluginObj = _resolveSpecExport(params.importMetaUrl, params.plugin);
        if (pluginObj == null) {
          throw new Error(
            `[sdk-shim] defineBundledChannelEntry: plugin ${params.plugin.specifier}#${params.plugin.exportName ?? 'default'} resolved to null/undefined`,
          );
        }
        _attachIdName(pluginObj, id, name);
        api.registerChannel({ plugin: pluginObj });
      }

      if (params?.runtime && api?.runtime != null) {
        const setRuntime = _resolveSpecExport(params.importMetaUrl, params.runtime);
        if (typeof setRuntime === 'function') setRuntime(api.runtime);
      }

      // Bridge mode always runs full registration. Upstream gates registerFull
      // behind `api.registrationMode === 'full'` to support discovery / cli-only
      // loads — we don't expose those modes through compat-api.
      if (typeof params?.registerFull === 'function') {
        params.registerFull(api);
      }
    },
  };
}

export function defineBundledChannelSetupEntry(params) {
  const id = params?.id || 'unknown';
  const name = params?.name || params?.id || 'Unknown';
  return {
    id,
    name,
    description: params?.description || '',
    register(api) {
      if (params?.plugin) {
        const pluginObj = _resolveSpecExport(params.importMetaUrl, params.plugin);
        if (pluginObj == null) {
          throw new Error(
            `[sdk-shim] defineBundledChannelSetupEntry: plugin ${params.plugin.specifier}#${params.plugin.exportName ?? 'default'} resolved to null/undefined`,
          );
        }
        _attachIdName(pluginObj, id, name);
        api.registerChannel({ plugin: pluginObj });
      }
      if (params?.runtime && api?.runtime != null) {
        const setRuntime = _resolveSpecExport(params.importMetaUrl, params.runtime);
        if (typeof setRuntime === 'function') setRuntime(api.runtime);
      }
      if (typeof params?.registerFull === 'function') {
        params.registerFull(api);
      }
    },
  };
}

// Internal — exported for callers that need the file path for diagnostics.
export function _diagnoseImportMetaUrl(importMetaUrl) {
  try {
    return fileURLToPath(importMetaUrl);
  } catch {
    return String(importMetaUrl);
  }
}
