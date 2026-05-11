// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/migration.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/migration.' + fn + '() not implemented in Bridge mode'); }
}

export function createMigrationItem() { _w('createMigrationItem'); return undefined; }
export function markMigrationItemConflict() { _w('markMigrationItemConflict'); return undefined; }
export function markMigrationItemError() { _w('markMigrationItemError'); return undefined; }
export function markMigrationItemSkipped() { _w('markMigrationItemSkipped'); return undefined; }
export function summarizeMigrationItems() { _w('summarizeMigrationItems'); return undefined; }
export function redactMigrationValue() { _w('redactMigrationValue'); return undefined; }
export function redactMigrationItem() { _w('redactMigrationItem'); return undefined; }
export function redactMigrationPlan() { _w('redactMigrationPlan'); return undefined; }
export const MIGRATION_REASON_MISSING_SOURCE_OR_TARGET = undefined;
export const MIGRATION_REASON_TARGET_EXISTS = undefined;
