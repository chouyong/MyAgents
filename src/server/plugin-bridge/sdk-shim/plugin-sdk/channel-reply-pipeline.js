// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./channel-reply-pipeline.auto.js";
// === END AUTO-AUGMENT ===

// Handwritten Bridge-mode implementation for createChannelReplyPipeline.
//
// In Bridge mode, the actual reply path is owned by MyAgents:
// compat-runtime.ts::channel.reply.dispatchReplyWithBufferedBlockDispatcher
// POSTs the inbound message to Rust's /api/im-bridge/message instead of
// invoking the plugin's `dispatcherOptions.deliver` callback. So whatever
// fields `replyPipeline` would normally inject into dispatcherOptions are
// ignored on this path. We only need the destructure to succeed.
//
// Yuanbao destructures `const { onModelSelected, ...replyPipeline } = ...`
// at dispatch-reply.js and threads `onModelSelected` into replyOptions. We
// supply a no-op so the call to it (if any) is harmless. `replyPipeline`
// becomes {}.
export function createChannelReplyPipeline() {
  return {
    onModelSelected: () => {},
  };
}
