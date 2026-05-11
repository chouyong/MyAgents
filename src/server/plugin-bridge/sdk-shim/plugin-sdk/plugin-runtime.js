// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/plugin-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/plugin-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function getPluginRuntimeGatewayRequestScope() { _w('getPluginRuntimeGatewayRequestScope'); return undefined; }
export async function executePluginCommand() { _w('executePluginCommand'); return undefined; }
export function matchPluginCommand() { _w('matchPluginCommand'); return undefined; }
export function listPluginCommands() { _w('listPluginCommands'); return []; }
export const __testing = undefined;
export function clearPluginCommands() { _w('clearPluginCommands'); return undefined; }
export function clearPluginCommandsForPlugin() { _w('clearPluginCommandsForPlugin'); return undefined; }
export function getPluginCommandSpecs() { _w('getPluginCommandSpecs'); return undefined; }
export function listProviderPluginCommandSpecs() { _w('listProviderPluginCommandSpecs'); return []; }
export function registerPluginCommand() { _w('registerPluginCommand'); return undefined; }
export function validateCommandName() { _w('validateCommandName'); return undefined; }
export function validatePluginCommandDefinition() { _w('validatePluginCommandDefinition'); return undefined; }
export async function runGlobalGatewayStopSafely() { _w('runGlobalGatewayStopSafely'); return undefined; }
export function initializeGlobalHookRunner() { _w('initializeGlobalHookRunner'); return undefined; }
export function getGlobalHookRunner() { _w('getGlobalHookRunner'); return undefined; }
export function getGlobalPluginRegistry() { _w('getGlobalPluginRegistry'); return undefined; }
export function hasGlobalHooks() { _w('hasGlobalHooks'); return false; }
export function resetGlobalHookRunner() { _w('resetGlobalHookRunner'); return undefined; }
export function normalizePluginHttpPath() { _w('normalizePluginHttpPath'); return ""; }
export function registerPluginHttpRoute() { _w('registerPluginHttpRoute'); return undefined; }
export function createInteractiveConversationBindingHelpers() { _w('createInteractiveConversationBindingHelpers'); return undefined; }
export async function dispatchPluginInteractiveHandler() { _w('dispatchPluginInteractiveHandler'); return undefined; }
export function clearPluginInteractiveHandlers() { _w('clearPluginInteractiveHandlers'); return undefined; }
export function clearPluginInteractiveHandlersForPlugin() { _w('clearPluginInteractiveHandlersForPlugin'); return undefined; }
export function registerPluginInteractiveHandler() { _w('registerPluginInteractiveHandler'); return undefined; }
export async function defaultLoadOverrideModule() { _w('defaultLoadOverrideModule'); return undefined; }
export async function startLazyPluginServiceModule() { _w('startLazyPluginServiceModule'); return undefined; }
export const PLUGIN_HOOK_NAMES = undefined;
export const isPluginHookName = undefined;
export const PROMPT_INJECTION_HOOK_NAMES = undefined;
export const isPromptInjectionHookName = undefined;
export const CONVERSATION_HOOK_NAMES = undefined;
export const isConversationHookName = undefined;
export const PluginApprovalResolutions = undefined;
export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = undefined;
export function stripPromptMutationFieldsFromLegacyHookResult() { _w('stripPromptMutationFieldsFromLegacyHookResult'); return ""; }
