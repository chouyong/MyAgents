import { describe, it, expect } from 'vitest';
import { normalizeNpmSpec, isDirtyChannelName, isDirtyDisplayName, resolveChannelDisplayName } from './channelDisplayName';

describe('normalizeNpmSpec', () => {
    it('strips version from scoped packages', () => {
        expect(normalizeNpmSpec('@scope/name@1.2.3')).toBe('@scope/name');
    });
    it('strips version from unscoped packages', () => {
        expect(normalizeNpmSpec('name@1.2.3')).toBe('name');
    });
    it('keeps scoped package without version intact', () => {
        expect(normalizeNpmSpec('@scope/name')).toBe('@scope/name');
    });
    it('keeps unscoped package without version intact', () => {
        expect(normalizeNpmSpec('name')).toBe('name');
    });
    it('handles empty input gracefully', () => {
        expect(normalizeNpmSpec('')).toBe('');
    });
    it('handles npm package paths used in production', () => {
        expect(normalizeNpmSpec('@larksuite/openclaw-lark')).toBe('@larksuite/openclaw-lark');
        expect(normalizeNpmSpec('@wecom/wecom-openclaw-plugin')).toBe('@wecom/wecom-openclaw-plugin');
        expect(normalizeNpmSpec('@sliverp/qqbot')).toBe('@sliverp/qqbot');
    });
});

describe('isDirtyChannelName', () => {
    const spec = '@larksuite/openclaw-lark';

    it('detects npm package name with @ prefix', () => {
        expect(isDirtyChannelName({ name: '@larksuite/openclaw-lark', openclawNpmSpec: spec })).toBe(true);
    });
    it('detects npm package name without @ prefix (the most common dirty form)', () => {
        expect(isDirtyChannelName({ name: 'larksuite/openclaw-lark', openclawNpmSpec: spec })).toBe(true);
    });
    it('detects versioned npm spec', () => {
        expect(isDirtyChannelName({ name: '@larksuite/openclaw-lark@1.2.3', openclawNpmSpec: '@larksuite/openclaw-lark@1.2.3' })).toBe(true);
    });
    it('treats user-supplied display names as clean', () => {
        expect(isDirtyChannelName({ name: 'My Custom Bot', openclawNpmSpec: spec })).toBe(false);
        expect(isDirtyChannelName({ name: '飞书', openclawNpmSpec: spec })).toBe(false);
        expect(isDirtyChannelName({ name: 'feishu_mino', openclawNpmSpec: spec })).toBe(false);
    });
    it('treats empty / missing name as not dirty', () => {
        expect(isDirtyChannelName({ name: '', openclawNpmSpec: spec })).toBe(false);
        expect(isDirtyChannelName({ openclawNpmSpec: spec })).toBe(false);
    });
    it('returns false when openclawNpmSpec is missing (built-in channel)', () => {
        // Built-in feishu/dingtalk/telegram have no openclawNpmSpec — name is
        // platform-derived, never dirty
        expect(isDirtyChannelName({ name: 'larksuite/openclaw-lark' })).toBe(false);
    });
});

describe('isDirtyDisplayName', () => {
    it('matches isDirtyChannelName behaviour for a wecom-style npm spec', () => {
        const spec = '@wecom/wecom-openclaw-plugin';
        expect(isDirtyDisplayName('wecom/wecom-openclaw-plugin', spec)).toBe(true);
        expect(isDirtyDisplayName('@wecom/wecom-openclaw-plugin', spec)).toBe(true);
        expect(isDirtyDisplayName('企业微信 真名', spec)).toBe(false);
    });
    it('returns false when openclawNpmSpec is absent (built-in / Telegram channel)', () => {
        // Telegram bot username could be anything — without a spec to compare
        // against, dirty detection short-circuits to false.
        expect(isDirtyDisplayName('@my_bot', undefined)).toBe(false);
        expect(isDirtyDisplayName('feishu_mino', undefined)).toBe(false);
    });
});

describe('resolveChannelDisplayName', () => {
    it('prefers status.botUsername when present', () => {
        const result = resolveChannelDisplayName(
            { type: 'feishu', name: 'fallback', openclawNpmSpec: '@x/y' },
            { botUsername: 'feishu_mino' },
            '飞书',
        );
        expect(result).toBe('feishu_mino');
    });
    it('prefixes telegram bot usernames with @', () => {
        expect(resolveChannelDisplayName(
            { type: 'telegram' },
            { botUsername: 'mino_bot' },
            'Telegram',
        )).toBe('@mino_bot');
    });
    it('skips dirty botUsername (e.g. historical npm-spec value loaded from disk) and falls through', () => {
        const result = resolveChannelDisplayName(
            { type: 'openclaw:wecom-openclaw-plugin', name: 'My Wecom', openclawNpmSpec: '@wecom/wecom-openclaw-plugin' },
            { botUsername: 'wecom/wecom-openclaw-plugin' },
            '企业微信',
        );
        expect(result).toBe('My Wecom');
    });
    it('skips dirty botUsername when channel.name is also dirty — ultimate fallback to platformLabel', () => {
        const result = resolveChannelDisplayName(
            { type: 'openclaw:wecom-openclaw-plugin', name: 'wecom/wecom-openclaw-plugin', openclawNpmSpec: '@wecom/wecom-openclaw-plugin' },
            { botUsername: 'wecom/wecom-openclaw-plugin' },
            '企业微信',
        );
        expect(result).toBe('企业微信');
    });
    it('falls back to channel.name when name is clean', () => {
        const result = resolveChannelDisplayName(
            { type: 'openclaw:openclaw-lark', name: 'My Custom Lark', openclawNpmSpec: '@larksuite/openclaw-lark' },
            undefined,
            '飞书',
        );
        expect(result).toBe('My Custom Lark');
    });
    it('skips dirty channel.name and falls back to platformLabel', () => {
        const result = resolveChannelDisplayName(
            { type: 'openclaw:wecom-openclaw-plugin', name: 'wecom/wecom-openclaw-plugin', openclawNpmSpec: '@wecom/wecom-openclaw-plugin' },
            undefined,
            '企业微信',
        );
        expect(result).toBe('企业微信');
    });
    it('uses platformLabel when no name and no botUsername', () => {
        const result = resolveChannelDisplayName(
            { type: 'openclaw:openclaw-weixin', openclawNpmSpec: '@tencent-weixin/openclaw-weixin' },
            undefined,
            '微信',
        );
        expect(result).toBe('微信');
    });
    it('treats whitespace-only botUsername as empty (falls through)', () => {
        const result = resolveChannelDisplayName(
            { type: 'feishu', name: 'My Lark' },
            { botUsername: '   ' },
            '飞书',
        );
        expect(result).toBe('My Lark');
    });
});
