/**
 * Bot identity resolution for OpenClaw bridge plugins.
 *
 * Why this exists: BridgeAdapter::verify_connection used to return the npm
 * package name (e.g. `@wecom/wecom-openclaw-plugin`) as bot identity, which
 * surfaced in the renderer as the bot's display name — useless for
 * distinguishing two bots of the same plugin. This module provides a
 * platform-aware resolver that calls the bot's own platform API to fetch
 * the real display name.
 *
 * Three-tier fallback (priority order):
 *   1. plugin-callback (future): if upstream OpenClaw adds a standard
 *      `gateway.getBotIdentity(ctx)` callback, prefer that (not yet implemented).
 *   2. bridge-api: this module's RESOLVERS map — pluginId → fetch from
 *      platform API using config credentials.
 *   3. config-fallback: caller (Rust adapter) maps null → `bot_username = None`,
 *      renderer displays the platform label (e.g. "企业微信" / "微信").
 *
 * Cache lifetime: module-scoped — one bridge process serves one channel,
 * so cache is per-channel. Bridge restart re-resolves.
 *
 * Abort: `abortResolver()` is invoked from index.ts shutdown / stopAccount
 * paths; the shared AbortController propagates to every fetch via cancellableFetch.
 */

import { cancellableFetch } from '../utils/cancellation';

export interface BotIdentity {
    displayName: string;
}

type Resolver = (cfg: Record<string, unknown>, signal: AbortSignal) => Promise<BotIdentity | null>;

const FETCH_TIMEOUT_MS = 3_000;

let cached: BotIdentity | null = null;
let resolving: Promise<BotIdentity | null> | null = null;
const resolverAbort = new AbortController();

/**
 * Strip secret-shaped substrings from an error message. Resolver impls can
 * accidentally surface tokens / keys via fetch error wrappers — this is a
 * conservative second line of defense (the impls themselves should also
 * never construct messages from cfg).
 */
function safeErrMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
        // Bearer / QQBot auth headers
        .replace(/Bearer\s+\S+/gi, 'Bearer ***')
        .replace(/QQBot\s+\S+/gi, 'QQBot ***')
        // JSON body fields that carry tokens / secrets
        .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"***"')
        .replace(/"tenant_access_token"\s*:\s*"[^"]+"/g, '"tenant_access_token":"***"')
        .replace(/"app_access_token"\s*:\s*"[^"]+"/g, '"app_access_token":"***"')
        .replace(/"app_secret"\s*:\s*"[^"]+"/gi, '"app_secret":"***"')
        .replace(/"appSecret"\s*:\s*"[^"]+"/g, '"appSecret":"***"')
        .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret":"***"')
        .replace(/"clientSecret"\s*:\s*"[^"]+"/g, '"clientSecret":"***"')
        // Feishu tenant_access_token shape
        .replace(/t-[A-Za-z0-9_-]{20,}/g, 't-***');
}

const RESOLVERS: Record<string, Resolver> = {
    'openclaw-lark': async (cfg, signal) => {
        const appId = typeof cfg.appId === 'string' ? cfg.appId : undefined;
        const appSecret = typeof cfg.appSecret === 'string' ? cfg.appSecret : undefined;
        if (!appId || !appSecret) return null;

        // Step 1: tenant_access_token (3s)
        const tokenResp = await cancellableFetch(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
            },
            { timeoutMs: FETCH_TIMEOUT_MS, parentSignal: signal },
        );
        const tokenData = await tokenResp.json() as { tenant_access_token?: string };
        const token = tokenData.tenant_access_token;
        if (!token) return null;

        // Step 2: bot info (3s)
        const infoResp = await cancellableFetch(
            'https://open.feishu.cn/open-apis/bot/v3/info',
            { headers: { Authorization: `Bearer ${token}` } },
            { timeoutMs: FETCH_TIMEOUT_MS, parentSignal: signal },
        );
        const infoData = await infoResp.json() as { bot?: { app_name?: string } };
        const name = infoData.bot?.app_name?.trim();
        return name ? { displayName: name } : null;
    },

    'qqbot': async (cfg, signal) => {
        const appId = typeof cfg.appId === 'string' ? cfg.appId : undefined;
        const clientSecret = typeof cfg.clientSecret === 'string' ? cfg.clientSecret : undefined;
        if (!appId || !clientSecret) return null;

        // Step 1: app access token (3s)
        const tokenResp = await cancellableFetch(
            'https://bots.qq.com/app/getAppAccessToken',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId, clientSecret }),
            },
            { timeoutMs: FETCH_TIMEOUT_MS, parentSignal: signal },
        );
        const tokenData = await tokenResp.json() as { access_token?: string };
        const token = tokenData.access_token;
        if (!token) return null;

        // Step 2: bot user info (3s) — auth scheme is `QQBot <token>`, NOT Bearer
        const meResp = await cancellableFetch(
            'https://api.sgroup.qq.com/users/@me',
            { headers: { Authorization: `QQBot ${token}` } },
            { timeoutMs: FETCH_TIMEOUT_MS, parentSignal: signal },
        );
        const meData = await meResp.json() as { username?: string };
        const name = meData.username?.trim();
        return name ? { displayName: name } : null;
    },
};

/**
 * Resolve and cache the bot's display name. Idempotent — repeat calls return
 * the cached result (or share the in-flight promise).
 */
export async function getBotIdentity(
    pluginId: string,
    cfg: Record<string, unknown>,
): Promise<BotIdentity | null> {
    if (cached) return cached;
    if (resolving) return resolving;

    const resolver = RESOLVERS[pluginId];
    if (!resolver) {
        // No resolver for this plugin (wecom / weixin / unknown plugins).
        // Return null directly — the RESOLVERS lookup above is the actual
        // short-circuit. Renderer falls back to platformLabel.
        return null;
    }

    resolving = resolver(cfg, resolverAbort.signal)
        .then(result => {
            cached = result;
            return result;
        })
        .catch(err => {
            console.warn(`[bot-identity] ${pluginId} resolution failed: ${safeErrMessage(err)}`);
            cached = null;
            return null;
        })
        .finally(() => {
            resolving = null;
        });

    return resolving;
}

/**
 * Abort any in-flight resolver fetches. Called from bridge shutdown / stopAccount
 * paths so we don't leak HTTP requests after the plugin's lifecycle ends.
 */
export function abortResolver(): void {
    resolverAbort.abort();
}

/** Exported for unit tests only — never call from production code. */
export const _internals = {
    safeErrMessage,
};
