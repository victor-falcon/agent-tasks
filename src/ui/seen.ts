// The attention "seen" state: a failure stays in Needs attention until it is
// seen (opened, or dismissed with `x`). Persisting it (state/tui.json) comes
// later; until then nothing is ever seen and the 24-hour window is the only
// filter. The Overview asks through this interface, so the persisted version
// only replaces `createSeen`.

export interface Seen {
  isSeen(ref: string): boolean;
  /** Called when a run of Needs attention is opened. */
  markSeen(ref: string): void;
}

export function createSeen(): Seen {
  return { isSeen: () => false, markSeen: () => {} };
}
