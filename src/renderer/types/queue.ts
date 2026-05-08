/** Lightweight image info for queued messages (no File blob to avoid memory leaks) */
export interface QueuedImageInfo {
  id: string;
  name: string;
  preview: string; // data URL for preview display
}

export interface QueuedMessageInfo {
  queueId: string;
  text: string;                // Original text, for cancel → restore to input
  images?: QueuedImageInfo[];  // Lightweight image info for display and restore
  timestamp: number;
  /**
   * (v0.2.12) True when this queue item has already been yielded to the
   * SDK CLI subprocess and is waiting to be drained into AI's context.
   * Once true, the message has crossed the process boundary into CLI's
   * commandQueue and there is no SDK API to retract it — the X (cancel)
   * button must not be rendered for it. The play (▷ force-execute)
   * button stays visible: clicking it interrupts the current turn so AI
   * processes the queued message right away instead of after the next
   * tool break.
   */
  isInFlight?: boolean;
}
