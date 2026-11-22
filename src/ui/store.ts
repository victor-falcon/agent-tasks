import { type FSWatcher, watch } from "node:fs";
import { type Accessor, batch, createSignal } from "solid-js";
import type { Context } from "../context.ts";
import { buildDashboard, type Dashboard } from "../tui/snapshot.ts";

// The data every view reads, as signals: the dashboard snapshot of the data
// layer (buildDashboard, the same one `top --json` prints), the context it was
// read with, and a clock. Refreshed like the old dashboard: a watcher on the
// data folder (debounced), a slow reload in case it misses something, and the
// clock every second so relative times move.

/** Redraw period, so elapsed times and relative times move. */
export const CLOCK_MS = 1000;
/** Reload period when nothing in the data folder seems to change (and the watcher is not available). */
export const RELOAD_MS = 15_000;
/**
 * Changes in the data folder come in bursts (a run file, its log,
 * ticks.jsonl…), and a running agent's log keeps changing: reload at most
 * this often.
 */
export const WATCH_DEBOUNCE_MS = 1000;

export interface StoreOptions {
  /** The clock (the real time, shifted by `--now`). */
  now(): Date;
  /** A fresh context at `now` (config re-read). */
  context(now: Date): Context;
  /** Folder to watch for changes (the data folder); null to rely on the reload timer. */
  watchDir: string | null;
}

export interface Store {
  dash: Accessor<Dashboard | null>;
  ctx: Accessor<Context | null>;
  now: Accessor<Date>;
  /** Why the last reload failed (what is shown is the previous snapshot), or null. */
  loadError: Accessor<string | null>;
  /** Bumped on every reload, for views that read more than the snapshot (a run's log). */
  version: Accessor<number>;
  /** Reads everything again now. */
  reload(): void;
  /** While paused (a command has the terminal), reloads wait. */
  setPaused(paused: boolean): void;
  start(): void;
  stop(): void;
}

export function createStore(opts: StoreOptions): Store {
  const [dash, setDash] = createSignal<Dashboard | null>(null);
  const [ctx, setCtx] = createSignal<Context | null>(null);
  const [now, setNow] = createSignal(opts.now(), { equals: false });
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [version, setVersion] = createSignal(0);
  let timers: ReturnType<typeof setInterval>[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let paused = false;
  let running = false;

  const reload = () => {
    if (paused) return;
    const at = opts.now();
    try {
      const context = opts.context(at);
      const snapshot = buildDashboard(context);
      batch(() => {
        setCtx(context);
        setDash(snapshot);
        setNow(at);
        setLoadError(null);
        setVersion((v) => v + 1);
      });
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };

  const scheduleReload = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      reload();
    }, WATCH_DEBOUNCE_MS);
  };

  return {
    dash,
    ctx,
    now,
    loadError,
    version,
    reload,
    setPaused(value) {
      paused = value;
    },
    start() {
      if (running) return;
      running = true;
      reload();
      timers.push(setInterval(() => !paused && setNow(opts.now()), CLOCK_MS));
      timers.push(setInterval(reload, RELOAD_MS));
      if (opts.watchDir) {
        try {
          watcher = watch(opts.watchDir, { recursive: true }, scheduleReload);
          watcher.on("error", () => watcher?.close());
        } catch {
          watcher = null; // the reload timer is enough
        }
      }
    },
    stop() {
      running = false;
      for (const t of timers) clearInterval(t);
      timers = [];
      if (debounce) clearTimeout(debounce);
      debounce = null;
      watcher?.close();
      watcher = null;
    },
  };
}
