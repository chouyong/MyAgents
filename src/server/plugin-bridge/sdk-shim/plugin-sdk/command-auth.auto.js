// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/command-auth.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/command-auth.' + fn + '() not implemented in Bridge mode'); }
}

export function buildCommandsMessage() { _w('buildCommandsMessage'); return undefined; }
export function buildCommandsMessagePaginated() { _w('buildCommandsMessagePaginated'); return undefined; }
export function buildHelpMessage() { _w('buildHelpMessage'); return undefined; }
export function buildCommandsPaginationKeyboard() { _w('buildCommandsPaginationKeyboard'); return undefined; }
export function createPreCryptoDirectDmAuthorizer() { _w('createPreCryptoDirectDmAuthorizer'); return undefined; }
export function resolveInboundDirectDmAccessWithRuntime() { _w('resolveInboundDirectDmAccessWithRuntime'); return undefined; }
export function hasControlCommand() { _w('hasControlCommand'); return false; }
export function hasInlineCommandTokens() { _w('hasInlineCommandTokens'); return false; }
export function isControlCommandMessage() { _w('isControlCommandMessage'); return false; }
export function buildCommandText() { _w('buildCommandText'); return undefined; }
export function buildCommandTextFromArgs() { _w('buildCommandTextFromArgs'); return undefined; }
export function findCommandByNativeName() { _w('findCommandByNativeName'); return undefined; }
export function formatCommandArgMenuTitle() { _w('formatCommandArgMenuTitle'); return ""; }
export function getCommandDetection() { _w('getCommandDetection'); return undefined; }
export function isCommandEnabled() { _w('isCommandEnabled'); return false; }
export function isCommandMessage() { _w('isCommandMessage'); return false; }
export function isNativeCommandSurface() { _w('isNativeCommandSurface'); return false; }
export function listChatCommands() { _w('listChatCommands'); return []; }
export function listChatCommandsForConfig() { _w('listChatCommandsForConfig'); return []; }
export function listNativeCommandSpecs() { _w('listNativeCommandSpecs'); return []; }
export function listNativeCommandSpecsForConfig() { _w('listNativeCommandSpecsForConfig'); return []; }
export function maybeResolveTextAlias() { _w('maybeResolveTextAlias'); return undefined; }
export function normalizeCommandBody() { _w('normalizeCommandBody'); return ""; }
export function parseCommandArgs() { _w('parseCommandArgs'); return undefined; }
export function resolveCommandArgChoices() { _w('resolveCommandArgChoices'); return undefined; }
export function resolveCommandArgMenu() { _w('resolveCommandArgMenu'); return undefined; }
export function resolveTextCommand() { _w('resolveTextCommand'); return undefined; }
export function serializeCommandArgs() { _w('serializeCommandArgs'); return ""; }
export function shouldHandleTextCommands() { _w('shouldHandleTextCommands'); return false; }
export function resolveNativeCommandSessionTargets() { _w('resolveNativeCommandSessionTargets'); return undefined; }
export function resolveCommandAuthorization() { _w('resolveCommandAuthorization'); return undefined; }
export function listReservedChatSlashCommandNames() { _w('listReservedChatSlashCommandNames'); return []; }
export function listSkillCommandsForAgents() { _w('listSkillCommandsForAgents'); return []; }
export function listSkillCommandsForWorkspace() { _w('listSkillCommandsForWorkspace'); return []; }
export function resolveSkillCommandInvocation() { _w('resolveSkillCommandInvocation'); return undefined; }
export function getPluginCommandSpecs() { _w('getPluginCommandSpecs'); return undefined; }
export function listProviderPluginCommandSpecs() { _w('listProviderPluginCommandSpecs'); return []; }
export function buildModelsProviderData() { _w('buildModelsProviderData'); return undefined; }
export function formatModelsAvailableHeader() { _w('formatModelsAvailableHeader'); return ""; }
export function resolveModelsCommandReply() { _w('resolveModelsCommandReply'); return undefined; }
export function resolveStoredModelOverride() { _w('resolveStoredModelOverride'); return undefined; }
