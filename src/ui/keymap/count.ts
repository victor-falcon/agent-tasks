import type { KeyEvent } from "@opentui/core";
import { type Accessor, createSignal } from "solid-js";
import { AMBIGUOUS_TIMEOUT_MS, type AppKeymap } from "./vim.ts";

// The count before a motion (`15j`), typed the way Vim users expect even
// though `1`–`4` are also keys of their own (the tabs).
//
// @opentui/keymap's `{count}` pattern can't do it: `1` is both a binding and
// the start of `{count}j`, and the second digit of `15j` cut that short (the
// `1` ran as "Overview", then the `5` started over). So digits are taken
// before the keymap sees them, Vim's way:
//
// - Once a count has started, every digit extends it (`15`, `120`); `0` only
//   continues a count, it never starts one.
// - The key after the count runs with it when it is a counted motion (j/k
//   and whatever tui.toml binds to `down`/`up`): `15j` moves 15 rows.
// - A lone digit that is a key of its own (`1`–`4`) still runs as that key:
//   after AMBIGUOUS_TIMEOUT_MS with no other key, or at once when the next key
//   is not a motion or a digit (`2` then `?` goes to Tasks, then shows help).
// - A count of two or more digits waits for its motion as long as it takes,
//   as in Vim; any other key drops it, and Esc cancels it.
// - Nothing is counted while an overlay or a text field has the keys, or in
//   the middle of a sequence (`g…`).

/** Longest count: 9999 rows is more than any list here. */
const MAX_DIGITS = 4;

export interface Count {
  /** The digits typed so far ("" for none), for the footer. */
  typed: Accessor<string>;
  /** The count for the action that runs now (1 without one); it is used up. */
  take(): number;
  dispose(): void;
}

export interface CountOptions {
  /** Whether keys go to the views now (no overlay, no text field). */
  enabled(): boolean;
  /** Whether a key is a counted motion (a single-key binding of `down`/`up`). */
  counted(event: KeyEvent): boolean;
}

function digitOf(event: KeyEvent): string | null {
  return !event.ctrl && !event.meta && !event.shift && /^[0-9]$/.test(event.name) ? event.name : null;
}

export function createCount(keymap: AppKeymap, opts: CountOptions): Count {
  const [typed, setTyped] = createSignal("");
  /** The count handed to the motion being dispatched now. */
  let armed: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const reset = () => {
    stopTimer();
    setTyped("");
  };

  /** The command a digit is bound to in the active layers (a tab), if any. */
  const commandOf = (digit: string): string | null => {
    const key = keymap.getActiveKeys().find((k) => k.display === digit && !k.continues && typeof k.command === "string");
    return (key?.command as string | undefined) ?? null;
  };
  /** Runs a lone digit as the key it is bound to. */
  const runLone = (digit: string) => {
    const command = commandOf(digit);
    if (command) keymap.runCommand(command);
  };

  const offKey = keymap.intercept(
    "key",
    (ctx) => {
      const event = ctx.event;
      if (!opts.enabled() || keymap.hasPendingSequence()) {
        if (typed() !== "") reset();
        return;
      }
      const digit = digitOf(event);
      if (digit !== null && (typed() !== "" || digit !== "0")) {
        ctx.consume();
        const next = typed().length < MAX_DIGITS ? typed() + digit : typed();
        setTyped(next);
        stopTimer();
        // Only a lone digit that is a key of its own has to decide on its own; a longer count waits for its motion.
        if (next.length === 1 && commandOf(next) !== null) {
          timer = setTimeout(() => {
            timer = null;
            const lone = typed();
            setTyped("");
            if (lone.length === 1) runLone(lone);
          }, AMBIGUOUS_TIMEOUT_MS);
        }
        return;
      }
      if (typed() === "") return;
      const count = typed();
      reset();
      if (opts.counted(event)) {
        armed = Number(count);
        return;
      }
      if (event.name === "escape") {
        ctx.consume();
        return;
      }
      // Not a motion: a lone digit was a key of its own; a longer count is dropped. The key goes on as usual.
      if (count.length === 1) runLone(count);
    },
    { priority: 10 },
  );
  // A count that no motion took (the key did nothing) does not stay for the next one.
  const offAfter = keymap.intercept("key:after", () => {
    armed = null;
  });

  return {
    typed,
    take() {
      const n = armed ?? 1;
      armed = null;
      return n;
    },
    dispose() {
      stopTimer();
      offKey();
      offAfter();
    },
  };
}
