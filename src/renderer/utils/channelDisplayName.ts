/**
 * Channel display name resolution for OpenClaw + built-in IM channels.
 *
 * Why this exists: when OpenClaw bridge couldn't surface a real bot identity,
 * the channel list rendered the npm package name (e.g. "wecom/wecom-openclaw-plugin")
 * — useless for distinguishing two bots of the same plugin. v0.2.10 fixes the
 * source by making BridgeAdapter::verify_connection pull from /identity, but
 * we still need:
 *
 *   1. A precise dirty-name detector so historical `channel.name` values
 *      written by buildChannelConfig (using `installedPlugin.manifest.name`
 *      = npm package name) don't shadow the platform label.
 *   2. A unified resolver so all five render points (list / detail / Cron
 *      delivery / wizard / etc.) agree on the same priority chain.
 *
 * Precedence:
 *   1. status.botUsername (real-time identity from BridgeAdapter or platform SDK)
 *   2. channel.name — IF it's not detected as dirty
 *   3. platformLabel (from getPlatformLabel(channel.type) — e.g. "企业微信")
 */

/**
 * Normalize an npm spec to its bare package name (strip version, keep scope).
 * Mirrors `src-tauri/src/im/bridge.rs::resolve_npm_pkg_name`.
 *
 *   "@scope/name@1.2.3" → "@scope/name"
 *   "name@1.2.3"        → "name"
 *   "@scope/name"       → "@scope/name"
 *   "name"              → "name"
 */
export function normalizeNpmSpec(spec: string): string {
    if (!spec) return spec;
    if (spec.startsWith('@')) {
        // Scoped package: split on '@' yields ['', 'scope/name', 'version'?]
        const parts = spec.split('@');
        return parts.length >= 3 ? `@${parts[1]}` : spec;
    }
    // Unscoped: everything before the first '@' is the package name
    const at = spec.indexOf('@');
    return at < 0 ? spec : spec.slice(0, at);
}

/**
 * Detect whether a string is a npm-spec-derived dirty value (left over from
 * a prior code path that wrote `installedPlugin.manifest.name`, the npm
 * package name, into a display field).
 *
 * Used both at the read side (renderer fallback) and the write side
 * (ChannelWizard buildChannelConfig + auto-sync) — single source of truth.
 *
 * Strategy: build the set of all npm-spec-derived forms of `openclawNpmSpec`
 * (with/without leading `@`, with/without version) and check membership.
 *
 * Returns false when:
 *   - value is empty
 *   - openclawNpmSpec is missing (built-in channels — value is platform-specific
 *     and never an npm spec)
 *   - value is a legitimate user-supplied or platform-supplied display name
 */
export function isDirtyDisplayName(
    value: string | undefined | null,
    openclawNpmSpec: string | undefined,
): boolean {
    const trimmed = value?.trim();
    if (!trimmed) return false;
    const spec = openclawNpmSpec?.trim();
    if (!spec) return false;

    const bare = normalizeNpmSpec(spec);
    const candidates = new Set([
        bare,
        bare.replace(/^@/, ''),
        spec,
        spec.replace(/^@/, ''),
    ]);
    return candidates.has(trimmed);
}

/** Convenience wrapper for the channel.name shape — preserves the original API. */
export function isDirtyChannelName(channel: {
    name?: string;
    openclawNpmSpec?: string;
}): boolean {
    return isDirtyDisplayName(channel.name, channel.openclawNpmSpec);
}

/**
 * Resolve the user-facing display name for a channel.
 *
 * @param channel  Full ChannelConfig (must include `type`, `name?`, `openclawNpmSpec?`)
 * @param status   Optional runtime status carrying `botUsername` from the platform
 * @param platformLabel  Output of `getPlatformLabel(channel.type)` — passed in to
 *                       avoid creating a circular dependency between this util and
 *                       the platformLabel module
 */
export function resolveChannelDisplayName(
    channel: { type: string; name?: string; openclawNpmSpec?: string },
    status: { botUsername?: string | null } | null | undefined,
    platformLabel: string,
): string {
    const botUsername = status?.botUsername?.trim();
    // Apply dirty-name detection to runtime botUsername too — the disk-loaded
    // ImHealthState may carry a historical npm-spec-shaped value before the
    // post-v0.2.10 BridgeAdapter::verify_connection has had a chance to clear
    // it. Without this gate, the renderer would render the dirt for the 0–15s
    // window between app start and verify completing.
    if (botUsername && !isDirtyDisplayName(botUsername, channel.openclawNpmSpec)) {
        return channel.type === 'telegram' ? `@${botUsername}` : botUsername;
    }
    if (channel.name && !isDirtyChannelName(channel)) {
        return channel.name;
    }
    return platformLabel;
}
