// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-inbound.auto.js";
// === END AUTO-AUGMENT ===

// Handwritten Bridge-mode implementation for inbound-debounce surface.
// The upstream openclaw npm package itself stubs these to undefined (debounce
// is host-provided); some plugins (openclaw-plugin-yuanbao) call the factory
// directly and read `.debouncer.enqueue(item)`. Returning undefined from the
// factory crashes the WS dispatcher (issue #208). We provide a pass-through
// debouncer that flushes each item immediately — Bridge mode does not aggregate
// inbound bursts; behavior matches the existing `compat-runtime.ts` debounce
// policy, which also flushes immediately.

export function createChannelInboundDebouncer(opts) {
  const onFlush = opts && opts.onFlush;
  const onError = opts && opts.onError;
  const debouncer = {
    enqueue: async (item) => {
      try {
        if (onFlush) await onFlush([item]);
      } catch (err) {
        if (onError) {
          try { onError(err, [item]); } catch { /* swallow */ }
        }
      }
    },
    cancel: () => {},
    flush: async () => {},
  };
  return { debouncer };
}

export function shouldDebounceTextInbound() { return false; }

// Bridge mode doesn't use the plugin's own session-envelope path — MyAgents
// hands inbound text to its own AI runtime (compat-runtime.ts forwards to
// /api/im-bridge/message) and `core.channel.session.recordInboundSession`
// is a no-op stub. Plugin callers destructure {storePath, envelopeOptions,
// previousTimestamp} from this return; provide harmless defaults so they
// don't crash before reaching the dispatcher.
//
// storePath MUST be truthy: at least yuanbao's build-context / dispatch-reply
// middlewares short-circuit on `!storePath` and silently drop the message
// before it ever reaches the compat-runtime POST path. Use a non-filesystem
// sentinel so any plugin that accidentally treats it as a real path fails
// loudly instead of writing to ./bridge-noop.
export function resolveInboundSessionEnvelopeContext() {
  return { storePath: 'bridge://noop', envelopeOptions: {}, previousTimestamp: 0 };
}

// Bridge mode delegates @-mention / group gating to the Rust layer's group
// approval UI (compat-runtime resolveGroupPolicy returns allowed=true and
// resolveRequireMention returns false). Plugin-level gating here just passes
// through with the caller's wasMentioned value and never asks to skip.
export function resolveMentionGatingWithBypass(params) {
  return {
    effectiveWasMentioned: !!(params && params.wasMentioned),
    shouldSkip: false,
  };
}
