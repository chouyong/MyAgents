/**
 * Issue #124 — per-subprocess bridge token registry.
 *
 * The architectural invariant under test: concurrent SDK subprocesses
 * (active session, verify, title-gen, sub-agent) each register under
 * their own token; one's config never leaks into another's. This was
 * structurally impossible pre-#124 because there was a single shared
 * global `currentOpenAiBridgeConfig`.
 *
 * Cases:
 *  (a) register + lookup returns the config
 *  (b) unregister removes the entry
 *  (c) unknown token returns undefined (caller will respond 400)
 *  (d) two concurrent bridges with different configs do NOT mix
 *  (e) re-registering same token replaces (intentional)
 *  (f) resolver is called per-lookup, so dynamic config (model, etc.)
 *      reflects live state without re-registration
 *  (g) listBridges returns metadata without leaking apiKey
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  registerBridge,
  unregisterBridge,
  lookupBridge,
  listBridges,
  _clearRegistryForTests,
} from '../openai-bridge/bridge-registry';

afterEach(() => {
  _clearRegistryForTests();
});

const baseConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-secret-1234',
  model: 'test-model',
  modelAliases: undefined,
  maxOutputTokens: 4096,
};

describe('bridge-registry — single-tenant', () => {
  it('(a) register + lookup returns the config', () => {
    registerBridge('tok-A', () => ({ ...baseConfig }), 'session:test');
    const cfg = lookupBridge('tok-A');
    expect(cfg).toBeDefined();
    expect(cfg!.baseUrl).toBe('https://api.example.com');
    expect(cfg!.apiKey).toBe('sk-secret-1234');
    expect(cfg!.model).toBe('test-model');
  });

  it('(b) unregister removes the entry', () => {
    registerBridge('tok-A', () => ({ ...baseConfig }), 'session:test');
    expect(lookupBridge('tok-A')).toBeDefined();
    unregisterBridge('tok-A');
    expect(lookupBridge('tok-A')).toBeUndefined();
  });

  it('(c) unknown token returns undefined', () => {
    expect(lookupBridge('nonexistent')).toBeUndefined();
  });

  it('unregister of non-existent token is a no-op (idempotent)', () => {
    expect(() => unregisterBridge('never-registered')).not.toThrow();
  });
});

describe('bridge-registry — multi-tenant isolation (#124 core)', () => {
  it('(d) two concurrent bridges with different upstreams do NOT mix', () => {
    registerBridge('tok-chat', () => ({
      ...baseConfig,
      baseUrl: 'https://chat-provider.com',
      apiKey: 'sk-chat',
      model: 'chat-model',
    }), 'session:chat');

    registerBridge('tok-verify', () => ({
      ...baseConfig,
      baseUrl: 'https://verify-provider.com',
      apiKey: 'sk-verify',
      model: 'verify-model',
    }), 'verify:moonshot');

    const chat = lookupBridge('tok-chat')!;
    const verify = lookupBridge('tok-verify')!;

    // The whole point: each token resolves to ITS config, not the other's.
    expect(chat.baseUrl).toBe('https://chat-provider.com');
    expect(chat.apiKey).toBe('sk-chat');
    expect(verify.baseUrl).toBe('https://verify-provider.com');
    expect(verify.apiKey).toBe('sk-verify');

    // Unregister one — the other survives untouched.
    unregisterBridge('tok-verify');
    expect(lookupBridge('tok-chat')).toBeDefined();
    expect(lookupBridge('tok-chat')!.baseUrl).toBe('https://chat-provider.com');
    expect(lookupBridge('tok-verify')).toBeUndefined();
  });

  it('(d) parallel verify simulations: dozens of tokens coexist without interference', () => {
    const N = 20;
    for (let i = 0; i < N; i++) {
      registerBridge(`tok-${i}`, () => ({
        ...baseConfig,
        baseUrl: `https://provider-${i}.com`,
        apiKey: `sk-${i}`,
        model: `model-${i}`,
      }), `verify:${i}`);
    }

    // Every token resolves to its own config.
    for (let i = 0; i < N; i++) {
      const cfg = lookupBridge(`tok-${i}`)!;
      expect(cfg.baseUrl).toBe(`https://provider-${i}.com`);
      expect(cfg.apiKey).toBe(`sk-${i}`);
      expect(cfg.model).toBe(`model-${i}`);
    }
  });
});

describe('bridge-registry — resolver semantics', () => {
  it('(e) re-registering same token replaces the resolver (intentional)', () => {
    registerBridge('tok-X', () => ({ ...baseConfig, model: 'first' }), 'first');
    expect(lookupBridge('tok-X')!.model).toBe('first');

    registerBridge('tok-X', () => ({ ...baseConfig, model: 'second' }), 'second');
    expect(lookupBridge('tok-X')!.model).toBe('second');
  });

  it('(f) dynamic resolver reflects live state without re-registration', () => {
    let currentModel = 'initial';
    registerBridge('tok-dyn', () => ({
      ...baseConfig,
      model: currentModel,
    }), 'session:dynamic');

    expect(lookupBridge('tok-dyn')!.model).toBe('initial');

    // Change the source variable — same token, new resolved value.
    currentModel = 'updated';
    expect(lookupBridge('tok-dyn')!.model).toBe('updated');

    // Still works after another lookup roundtrip.
    currentModel = 'updated-again';
    expect(lookupBridge('tok-dyn')!.model).toBe('updated-again');
  });
});

describe('bridge-registry — diagnostics', () => {
  it('(g) listBridges returns metadata without exposing apiKey', () => {
    registerBridge('tok-1', () => ({ ...baseConfig, apiKey: 'super-secret' }), 'verify:moonshot');
    registerBridge('tok-2', () => ({ ...baseConfig, apiKey: 'also-secret' }), 'session:abc');

    const list = listBridges();
    expect(list).toHaveLength(2);

    // Only metadata is exposed; apiKey never leaks.
    for (const entry of list) {
      expect(entry).toHaveProperty('token');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('ageMs');
      expect(entry).not.toHaveProperty('apiKey');
      expect(entry).not.toHaveProperty('config');
      expect(JSON.stringify(entry)).not.toContain('super-secret');
      expect(JSON.stringify(entry)).not.toContain('also-secret');
    }

    // ageMs is non-negative.
    for (const entry of list) {
      expect(entry.ageMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('bridge-registry — error propagation', () => {
  it('lookup returns undefined cleanly when resolver throws — wait, no, it propagates', () => {
    // Per the contract in bridge-registry.ts: a misbehaving resolver is a
    // bug to surface, not silently swallow. Lookup should let the throw out.
    registerBridge('tok-throws', () => {
      throw new Error('resolver broken');
    }, 'broken-test');

    expect(() => lookupBridge('tok-throws')).toThrow('resolver broken');
  });
});
