import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../errors.ts";
import { type Binding, KeymapError, parseKeys, TUI_CONFIG_FILE } from "../../tui/keys.ts";
import { VIEW_KEYS } from "../views/keys.ts";
import { ACTIONS, type Action, DEFAULT_KEYS } from "./actions.ts";
import type { ViewKeys } from "./spec.ts";

// tui.toml for the new dashboard: the old file format ([keys] with the same
// action names, Vim notation, the same errors), plus the new actions and a
// top-level `mouse = false`. The notation and the error messages are the old
// module's (parseKeys), so a file that worked before works here and a broken
// one fails with the same words.

export type Keymap = Record<Action, Binding[]>;

export interface TuiConfig {
  keymap: Keymap;
  /** Clicks, double-clicks and the wheel (on unless `mouse = false`). */
  mouse: boolean;
  /** The tui.toml in use, or null for the defaults. */
  file: string | null;
}

function bindingsOf(texts: readonly string[]): Binding[] {
  return texts.map((text) => ({ text, keys: parseKeys(text) }));
}

/** The default keymap with `overrides` applied, checked for conflicts within each view. */
export function buildKeymap(overrides: Record<string, unknown> = {}, views: readonly ViewKeys[] = VIEW_KEYS): Keymap {
  const errors: string[] = [];
  const keymap = Object.fromEntries(Object.entries(DEFAULT_KEYS).map(([a, texts]) => [a, bindingsOf(texts)])) as Keymap;
  for (const [action, value] of Object.entries(overrides)) {
    if (!(action in ACTIONS)) {
      errors.push(`keys.${action}: unknown action (known: ${Object.keys(ACTIONS).join(", ")})`);
      continue;
    }
    const texts = typeof value === "string" ? [value] : Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
    if (texts === null) {
      errors.push(`keys.${action}: expected a key or a list of keys, e.g. "j" or ["j", "<Down>"]`);
      continue;
    }
    try {
      keymap[action as Action] = bindingsOf(texts);
    } catch (err) {
      errors.push(`keys.${action}: ${(err as Error).message}`);
    }
  }
  if (errors.length === 0) errors.push(...conflicts(keymap, views));
  if (errors.length > 0) throw new KeymapError(errors);
  return keymap;
}

/** Two actions of the same view on the same keys, or one's keys a prefix of the other's (it would never fire). */
function conflicts(keymap: Keymap, views: readonly ViewKeys[]): string[] {
  const errors = new Set<string>();
  for (const view of views) {
    const all = view.actions.flatMap((action) => keymap[action].map((b) => ({ action, b })));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [x, y] = [all[i]!, all[j]!];
        if (x.action === y.action) continue;
        const [short, long] = x.b.keys.length <= y.b.keys.length ? [x, y] : [y, x];
        if (short.b.keys.every((k, n) => long.b.keys[n] === k)) {
          const what = short.b.keys.length === long.b.keys.length ? `"${short.b.text}" is bound to both` : `"${short.b.text}" (${short.action}) hides "${long.b.text}" (${long.action}); it is bound to`;
          errors.add(`${what} ${short.action} and ${long.action} in the ${view.id} view`);
        }
      }
    }
  }
  return [...errors];
}

/** Reads `<configDir>/tui.toml`; the defaults when it does not exist. */
export function loadTuiConfig(configDir: string, views: readonly ViewKeys[] = VIEW_KEYS): TuiConfig {
  const file = join(configDir, TUI_CONFIG_FILE);
  if (!existsSync(file)) return { keymap: buildKeymap({}, views), mouse: true, file: null };
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(file, [`invalid TOML: ${(err as Error).message}`]);
  }
  const root = parsed as Record<string, unknown>;
  const unknown = Object.keys(root).filter((k) => k !== "keys" && k !== "mouse");
  if (unknown.length > 0) throw new ConfigError(file, unknown.map((k) => `${k}: unknown setting (only [keys] and mouse are read)`));
  if (root.mouse !== undefined && typeof root.mouse !== "boolean") throw new ConfigError(file, ["mouse: expected true or false"]);
  const keys = root.keys ?? {};
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw new ConfigError(file, ["keys: must be a table, e.g. [keys]"]);
  try {
    return { keymap: buildKeymap(keys as Record<string, unknown>, views), mouse: root.mouse !== false, file };
  } catch (err) {
    if (err instanceof KeymapError) throw new ConfigError(file, err.details);
    throw err;
  }
}

/** The first key of each action, for the footer: `j/k`. */
export function keyHint(keymap: Keymap, action: Action): string | null {
  return keymap[action][0]?.text ?? null;
}
