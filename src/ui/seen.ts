import { readFileSync, statSync } from "node:fs";
import { type Accessor, createSignal } from "solid-js";
import { DAY } from "../output/time.ts";
import type { RunStatus } from "../schema.ts";
import { writeJsonAtomic } from "../store.ts";
import type { DashRun } from "../tui/snapshot.ts";

// The attention "seen" state: a failure stays in Needs attention until it is
// seen (opened in Run detail, or dismissed with `x` in the Overview). It is
// kept in state/tui.json in the data folder of the machine running the
// dashboard (on a client, `top` runs on the hub over SSH, so that is the
// hub's), so it survives a restart and is shared by every dashboard open
// there (`runner` and `top`).
//
// A mark is the run's `at` (when it last changed) at the time it was seen:
// a run retried and failed again has a later `at`, so it comes back. Marks
// whose run left the attention window are pruned on every write, so the file
// stays a day's worth of refs.
//
// Several dashboards share the file: each write re-reads it and merges
// before writing (temp file + rename, so a reader never sees half of one),
// and a reader re-reads it when it changed on disk (checked after each reload
// of the data folder, which the write itself causes), so a run dismissed in
// one dashboard leaves the others too. There is no lock: a write by another
// dashboard between this one's read and its rename loses that mark; the run
// then shows again until it is dismissed again, which is the safe way to be
// wrong. A missing or broken file is an empty one.

/** Failures and missed runs older than this leave Needs attention. */
export const ATTENTION_WINDOW_MS = DAY;

/** What stays in Needs attention until seen (blocked runs stay while they are blocked, seen or not). */
export const SEEABLE: readonly RunStatus[] = ["failed", "timed_out", "missed"];

/** The run `ref` among the dashboard's recent runs when Needs attention can show it until seen (a failure or missed run of the window), or null. */
export function seeableRun(recent: readonly DashRun[], ref: string, now: Date): DashRun | null {
  const since = now.getTime() - ATTENTION_WINDOW_MS;
  return recent.find((r) => r.ref === ref && SEEABLE.includes(r.status) && Date.parse(r.at) >= since) ?? null;
}

export interface Seen {
  /** Whether the run `ref`, as it was at `at`, was seen. Reactive: a view reading it updates when a run is marked. */
  isSeen(ref: string, at: string): boolean;
  /** Marks the run `ref`, as it is at `at`, seen (opened or dismissed). */
  markSeen(ref: string, at: string): void;
}

export interface SeenOptions {
  /** The file (state/tui.json); null keeps the marks in memory only (the data folder is unreadable). */
  file: string | null;
  /** The dashboard's clock: marks of runs older than the attention window are dropped (they left Needs attention anyway). */
  now(): Date;
  /** Bumped when the data folder changed (the store's reload): only then is the file checked for another dashboard's marks. Without it, on every read. */
  changed?: Accessor<number>;
}

const FORMAT = 1;

/** ref → the run's `at` when it was seen. */
type Marks = Map<string, string>;

interface TuiState {
  version: number;
  seen: Record<string, string>;
}

function readMarks(file: string): Marks {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<TuiState> | null;
    const seen = data && typeof data === "object" && data.seen && typeof data.seen === "object" ? data.seen : {};
    return new Map(Object.entries(seen).filter((e): e is [string, string] => typeof e[1] === "string" && !Number.isNaN(Date.parse(e[1]))));
  } catch {
    return new Map(); // missing or not JSON: nothing seen yet
  }
}

/** What identifies the file's current content: a rename gives it a new inode, a write a new time. */
function stamp(file: string): string {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.ino}:${s.mtimeNs}:${s.size}`;
  } catch {
    return "missing";
  }
}

/** Whether a mark made when the run was at `mark` covers the run as it is at `at` (it has not changed since). */
const covers = (mark: string, at: string) => Date.parse(mark) >= Date.parse(at);

export function createSeen(opts: SeenOptions): Seen {
  // Bumped on every mark made here, so the views reading isSeen update at once.
  const [revision, setRevision] = createSignal(0);
  let marks: Marks = new Map();
  /** The file's stamp when it was last read, and the reload it was checked at. */
  let read: string | null = null;
  let checkedAt: number | null = null;

  const prune = (from: Marks): Marks => {
    const since = opts.now().getTime() - ATTENTION_WINDOW_MS;
    return new Map([...from].filter(([, at]) => Date.parse(at) >= since));
  };

  /** Reads the file again if it changed since (another dashboard wrote it). */
  const sync = () => {
    if (opts.file === null) return;
    const now = stamp(opts.file);
    if (now === read) return;
    // Keep what this dashboard marked but could not write (a full disk, say);
    // pruned, so a mark another dashboard dropped does not come back.
    const merged = readMarks(opts.file);
    for (const [ref, at] of marks) if (!merged.has(ref) || covers(at, merged.get(ref)!)) merged.set(ref, at);
    marks = prune(merged);
    read = now;
  };

  return {
    isSeen(ref, at) {
      revision();
      const version = opts.changed?.() ?? null;
      if (version === null || version !== checkedAt) {
        sync();
        checkedAt = version;
      }
      const mark = marks.get(ref);
      return mark !== undefined && covers(mark, at);
    },
    markSeen(ref, at) {
      sync();
      const known = marks.get(ref);
      if (known !== undefined && covers(known, at)) return;
      marks = prune(new Map(marks).set(ref, at));
      if (opts.file !== null) {
        try {
          writeJsonAtomic(opts.file, { version: FORMAT, seen: Object.fromEntries(marks) } satisfies TuiState);
          read = stamp(opts.file);
        } catch {
          // Not written (read-only data folder): seen for as long as this dashboard runs.
        }
      }
      setRevision((r) => r + 1);
    },
  };
}
