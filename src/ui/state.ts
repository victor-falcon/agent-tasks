import { type Accessor, createSignal } from "solid-js";

// The UI's own state, apart from the data: which tab and view are shown (each
// tab keeps its stack of opened details, so coming back finds it as it was),
// the selection of each view by identity, the overlays (confirm, help, the
// command palette) and what goes in the footer (background commands, toasts).

export const TAB_IDS = ["overview", "tasks", "runs", "system"] as const;
export type TabId = (typeof TAB_IDS)[number];

/** A detail view opened on top of a tab: `{ view: "run", params: { ref } }`. */
export interface Route {
  view: string;
  params: Record<string, string>;
}

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  /** Runs when the user undoes it (`u`) while it shows. */
  undo?: () => void;
}

export interface Confirm {
  title: string;
  /** What saying yes does, in one line. */
  consequence: string;
  onYes(): void;
}

export interface Busy {
  id: number;
  text: string;
}

/** How long a toast stays; errors stay until dismissed. */
export const TOAST_MS = 6000;

export interface UiState {
  tab: Accessor<TabId>;
  setTab(tab: TabId): void;
  /** The view shown: the top of the current tab's stack, or the tab itself. */
  route: Accessor<Route>;
  push(route: Route): void;
  /** Closes the top detail; false when there is none (on a root, `back` does nothing). */
  pop(): boolean;
  /** The selected row of a view, by identity (`recent:<ref>`), or null. */
  selection(view: string): string | null;
  select(view: string, key: string | null): void;
  toasts: Accessor<readonly Toast[]>;
  toast(text: string, opts?: { error?: boolean; undo?: () => void }): number;
  /** Dismisses one toast, or all of them. */
  dismiss(id?: number): void;
  busy: Accessor<readonly Busy[]>;
  startBusy(text: string): number;
  endBusy(id: number): void;
  confirm: Accessor<Confirm | null>;
  ask(confirm: Confirm): void;
  answer(yes: boolean): void;
  help: Accessor<boolean>;
  setHelp(open: boolean): void;
  /** The command palette (`:`) is open. */
  palette: Accessor<boolean>;
  setPalette(open: boolean): void;
  /** A text field (the `/` filter bar) has the keys: the views' layers are off while it does. */
  typing: Accessor<boolean>;
  setTyping(on: boolean): void;
  /** An overlay or a text field takes the keys: the views' layers are off. */
  modal: Accessor<boolean>;
  /**
   * State of a view that must outlive its component (filters, sort order, the
   * sub-tab of a detail): views are unmounted while a detail is open on top
   * of them, and coming back must find them as they were. One signal per
   * `key`, created with `initial` the first time; a key always holds the same
   * type (prefix it with the view: `tasks:sort`). They live as long as the
   * dashboard: a few small values per view or task opened.
   */
  viewState<T>(key: string, initial: T): [Accessor<T>, (value: T) => void];
  dispose(): void;
}

export function createUiState(initialTab: TabId = "overview"): UiState {
  const [tab, setTab] = createSignal<TabId>(initialTab);
  const [stacks, setStacks] = createSignal(Object.fromEntries(TAB_IDS.map((id) => [id, []])) as unknown as Record<TabId, Route[]>);
  const [selections, setSelections] = createSignal<Record<string, string | null>>({});
  const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
  const [busy, setBusy] = createSignal<readonly Busy[]>([]);
  const [confirm, setConfirm] = createSignal<Confirm | null>(null);
  const [help, setHelp] = createSignal(false);
  const [palette, setPalette] = createSignal(false);
  const [typing, setTyping] = createSignal(false);
  const viewStates = new Map<string, [Accessor<unknown>, (value: unknown) => void]>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  const dismiss = (id?: number) => {
    const gone = id === undefined ? [...timers.keys()] : [id];
    for (const t of gone) {
      clearTimeout(timers.get(t));
      timers.delete(t);
    }
    setToasts((all) => (id === undefined ? [] : all.filter((t) => t.id !== id)));
  };

  return {
    tab,
    setTab,
    route: () => stacks()[tab()].at(-1) ?? { view: tab(), params: {} },
    push(route) {
      setStacks((s) => ({ ...s, [tab()]: [...s[tab()], route] }));
    },
    pop() {
      if (stacks()[tab()].length === 0) return false;
      setStacks((s) => ({ ...s, [tab()]: s[tab()].slice(0, -1) }));
      return true;
    },
    selection: (view) => selections()[view] ?? null,
    select(view, key) {
      setSelections((s) => (s[view] === key ? s : { ...s, [view]: key }));
    },
    toasts,
    toast(text, opts = {}) {
      const id = nextId++;
      setToasts((all) => [...all, { id, text, error: opts.error ?? false, undo: opts.undo }]);
      if (!opts.error) timers.set(id, setTimeout(() => dismiss(id), TOAST_MS));
      return id;
    },
    dismiss,
    busy,
    startBusy(text) {
      const id = nextId++;
      setBusy((all) => [...all, { id, text }]);
      return id;
    },
    endBusy(id) {
      setBusy((all) => all.filter((b) => b.id !== id));
    },
    confirm,
    ask: setConfirm,
    answer(yes) {
      const current = confirm();
      setConfirm(null);
      if (yes) current?.onYes();
    },
    help,
    setHelp,
    palette,
    setPalette,
    typing,
    setTyping,
    modal: () => confirm() !== null || help() || palette() || typing(),
    viewState<T>(key: string, initial: T) {
      let state = viewStates.get(key);
      if (!state) {
        const [get, set] = createSignal<unknown>(initial);
        state = [get, (value) => set(() => value)];
        viewStates.set(key, state);
      }
      return state as [Accessor<T>, (value: T) => void];
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
