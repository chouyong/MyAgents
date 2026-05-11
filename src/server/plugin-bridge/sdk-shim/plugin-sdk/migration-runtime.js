// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/migration-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/migration-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export async function archiveMigrationItem() { _w('archiveMigrationItem'); return undefined; }
export async function copyMigrationFileItem() { _w('copyMigrationFileItem'); return undefined; }
export async function writeMigrationReport() { _w('writeMigrationReport'); return undefined; }
