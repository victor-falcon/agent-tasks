import { type Accessor, createEffect, createMemo, on } from "solid-js";
import { useApp, type Handler } from "../context.ts";
import type { Action } from "../keymap/actions.ts";
import { type ListSection, listKeys } from "./section-list.tsx";

// Moving through a SectionList with the list keys (j/k with counts, gg/G,
// half pages, <Tab> between sections), the selection kept by identity in the
// UI state. Any list view (Overview, Tasks, Runs…) uses it the same way.

/** Rows taken by the header, the tab bar and the footer. */
const CHROME_ROWS = 3;

/**
 * The row to select after the rows change: the same one if it is still
 * there, else the same run or task in another section (the part after the
 * first `:` of a key, so a run that finished moves from `running:<ref>` to
 * `recent:<ref>`), else the row now at the same place, else the first.
 */
export function reconcileSelection(sections: readonly { rows: readonly { key: string }[] }[], previous: string | null, previousKeys: readonly string[]): string | null {
  const keys = sections.flatMap((s) => s.rows.map((r) => r.key));
  if (keys.length === 0) return null;
  if (previous === null) return keys[0]!;
  if (keys.includes(previous)) return previous;
  const id = (key: string) => key.slice(key.indexOf(":") + 1);
  const moved = keys.find((k) => id(k) === id(previous));
  if (moved) return moved;
  const index = previousKeys.indexOf(previous);
  return keys[Math.max(0, Math.min(keys.length - 1, index))] ?? keys[0]!;
}

export interface ListNavigation {
  selected: Accessor<string | null>;
  select(key: string | null): void;
  /** Handlers for the list actions, to pass to useViewKeys. */
  handlers: Partial<Record<Action, Handler>>;
}

export function useListNavigation(view: string, sections: Accessor<readonly ListSection[]>): ListNavigation {
  const { ui, renderer } = useApp();
  const keys = createMemo(() => listKeys(sections()), undefined, { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });
  const selected = () => ui.selection(view);
  const select = (key: string | null) => ui.select(view, key);

  createEffect(
    on(keys, (_, before) => {
      const next = reconcileSelection(sections(), selected(), before ?? []);
      if (next !== selected()) select(next);
    }),
  );

  const moveTo = (index: number) => {
    const all = keys();
    if (all.length > 0) select(all[Math.max(0, Math.min(all.length - 1, index))]!);
  };
  const move = (by: number) => moveTo(Math.max(0, keys().indexOf(selected() ?? "")) + by);
  const halfPage = () => Math.max(1, Math.floor((renderer.height - CHROME_ROWS) / 2));
  /** First row of the next (or previous) section that has rows, wrapping around. */
  const jumpSection = (direction: 1 | -1) => {
    const filled = sections().filter((s) => s.rows.length > 0);
    if (filled.length === 0) return;
    const here = filled.findIndex((s) => s.rows.some((r) => r.key === selected()));
    select(filled[(Math.max(0, here) + direction + filled.length) % filled.length]!.rows[0]!.key);
  };

  return {
    selected,
    select,
    handlers: {
      down: (n) => move(n),
      up: (n) => move(-n),
      first: () => moveTo(0),
      last: () => moveTo(Number.POSITIVE_INFINITY),
      half_page_down: () => move(halfPage()),
      half_page_up: () => move(-halfPage()),
      next_panel: () => jumpSection(1),
      prev_panel: () => jumpSection(-1),
    },
  };
}
