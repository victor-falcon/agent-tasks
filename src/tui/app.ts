import { type FSWatcher, watch } from "node:fs";
import type { Context } from "../context.ts";
import { colorEnabled, createStyle, type Style } from "../output/style.ts";
import { isInProgress } from "../run-info.ts";
import { displayTimezone } from "../task-info.ts";
import { buildRunDetail, isOpen, layoutDetail } from "./detail.ts";
import { type Action, type Keymap, KeyMatcher, decodeKeys } from "./keys.ts";
import { bodyHeight, initialState, maxScroll, PANELS, type PanelId, renderFrame, type ScreenState } from "./render.ts";
import { buildDashboard, type Dashboard, type DashRun } from "./snapshot.ts";

// The interactive dashboard: owns the terminal (alternate screen, raw
// input), redraws on data changes and every second, turns keys into
// actions and runs the CLI's own commands for retry, run, pause and attach.

/** Vim's `timeoutlen`: how long a key that starts a longer binding waits for the rest. */
const SEQUENCE_TIMEOUT_MS = 1000;
/** Redraw period, so elapsed times and relative times move. */
const REDRAW_MS = 1000;
/** Reload period when nothing in the data folder seems to change (and the watcher is not available). */
const RELOAD_MS = 15_000;
/**
 * Changes in the data folder come in bursts (a run file, its log,
 * ticks.jsonl…), and a running agent's log keeps changing: reload at most
 * this often.
 */
const WATCH_DEBOUNCE_MS = 1000;
const FLASH_MS = 6000;

/** The terminal the dashboard draws on and reads keys from. */
export interface TuiTerminal {
  write(text: string): void;
  size(): { width: number; height: number };
  onResize(listener: () => void): () => void;
  /** Starts delivering keyboard input (raw mode) until the returned function is called. */
  readInput(listener: (data: string) => void): () => void;
}

/** Runs an agent-tasks command. `interactive`: hand the terminal over and wait for it. */
export type CommandRunner = (args: string[], opts: { interactive: boolean }) => Promise<{ code: number; output: string }>;

export interface TuiOptions {
  title: string;
  keymap: Keymap;
  keymapFile: string | null;
  /** The clock (the real time, shifted by `--now`). */
  now(): Date;
  /** A fresh context at `now` (config re-read). */
  context(now: Date): Context;
  terminal: TuiTerminal;
  env: Record<string, string | undefined>;
  exec: CommandRunner;
  /** The user asked to quit (q, Ctrl-C). */
  onQuit(): void;
  /** Folder to watch for changes (the data folder); null to rely on the reload timer. */
  watchDir: string | null;
}

/** What a key acts on: a run, or a task that has no run selected. */
type Target = { kind: "run"; run: DashRun } | { kind: "task"; task_id: string; paused: boolean };

export class Tui {
  private readonly state: ScreenState = initialState();
  private readonly matcher: KeyMatcher;
  private readonly style: Style;
  private dash: Dashboard | null = null;
  private loadError: string | null = null;
  private ctx!: Context;
  private stopInput: (() => void) | null = null;
  private stopResize: (() => void) | null = null;
  private watcher: FSWatcher | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sequenceTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmed: (() => void) | null = null;
  /** True while a command has the terminal (attach). */
  private suspended = false;
  private running = false;

  constructor(private readonly opts: TuiOptions) {
    this.matcher = new KeyMatcher(opts.keymap);
    this.style = createStyle(colorEnabled({ write: () => {}, isTTY: true }, opts.env));
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.enterScreen();
    this.reload();
    // A run's text is wrapped to the width: build it again.
    this.stopResize = this.opts.terminal.onResize(() => this.reload());
    this.timers.push(setInterval(() => this.draw(), REDRAW_MS));
    this.timers.push(setInterval(() => this.reload(), RELOAD_MS));
    if (this.opts.watchDir) {
      try {
        this.watcher = watch(this.opts.watchDir, { recursive: true }, () => this.scheduleReload());
        this.watcher.on("error", () => this.watcher?.close());
      } catch {
        this.watcher = null; // the reload timer is enough
      }
    }
  }

  /** Gives the terminal back. Safe to call more than once. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of [this.sequenceTimer, this.flashTimer, this.reloadTimer]) if (t) clearTimeout(t);
    this.watcher?.close();
    this.stopResize?.();
    this.leaveScreen();
  }

  private enterScreen(): void {
    this.opts.terminal.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.stopInput = this.opts.terminal.readInput((data) => this.onInput(data));
  }

  private leaveScreen(): void {
    this.stopInput?.();
    this.stopInput = null;
    this.opts.terminal.write("\x1b[?25h\x1b[?1049l");
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reload();
    }, WATCH_DEBOUNCE_MS);
  }

  /** Reads everything again (and the open run), then redraws. */
  reload(): void {
    if (!this.running || this.suspended) return;
    try {
      this.ctx = this.opts.context(this.opts.now());
      this.dash = buildDashboard(this.ctx);
      this.loadError = null;
      const detail = this.state.detail;
      if (detail) {
        try {
          detail.detail = buildRunDetail(this.ctx, this.style, detail.detail.ref, this.width);
          detail.selected = Math.min(detail.selected, detail.detail.sections.length - 1);
        } catch {
          // The run file is being rewritten or gone: keep what is shown.
        }
      }
    } catch (err) {
      this.loadError = (err as Error).message;
    }
    this.draw();
  }

  private get width(): number {
    return Math.max(20, this.opts.terminal.size().width);
  }

  private get body(): number {
    return bodyHeight(this.opts.terminal.size().height);
  }

  draw(): void {
    if (!this.running || this.suspended) return;
    const { width, height } = this.opts.terminal.size();
    let lines: string[];
    if (!this.dash) lines = [this.loadError ? `agent-tasks: ${this.loadError}` : "loading…"];
    else {
      if (this.loadError && !this.state.flash) this.state.flash = { text: `could not reload: ${this.loadError}`, error: true };
      lines = renderFrame({
        dash: this.dash,
        state: this.state,
        keymap: this.opts.keymap,
        keymapFile: this.opts.keymapFile,
        width,
        height,
        style: this.style,
        timezone: displayTimezone(this.ctx),
        now: this.opts.now(),
        title: this.opts.title,
      });
    }
    this.opts.terminal.write(`\x1b[H${lines.join("\r\n")}\x1b[J`);
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private onInput(data: string): void {
    for (const key of decodeKeys(data)) this.onKey(key);
    this.draw();
  }

  /** One key (canonical Vim notation). Public for tests. */
  onKey(key: string): void {
    if (key === "<C-c>") return this.quit();
    if (this.state.confirm) {
      const yes = key === "y" || key === "Y";
      const action = this.confirmed;
      this.state.confirm = null;
      this.confirmed = null;
      if (yes) action?.();
      return;
    }
    if (this.state.help) {
      this.state.help = false;
      return;
    }
    if (this.sequenceTimer) clearTimeout(this.sequenceTimer);
    this.sequenceTimer = null;
    const result = this.matcher.feed(key, this.state.view);
    this.state.pending = this.matcher.pendingText;
    if (result.kind === "pending") {
      this.sequenceTimer = setTimeout(() => {
        this.matcher.reset();
        this.state.pending = "";
        this.draw();
      }, SEQUENCE_TIMEOUT_MS);
      return;
    }
    if (result.kind === "action") this.act(result.action);
  }

  private act(action: Action): void {
    this.state.flash = null;
    switch (action) {
      case "down":
        return this.move(1);
      case "up":
        return this.move(-1);
      case "first":
        return this.move(-Infinity);
      case "last":
        return this.move(Infinity);
      case "half_page_down":
        return this.move(Math.max(1, Math.floor(this.body / 2)));
      case "half_page_up":
        return this.move(-Math.max(1, Math.floor(this.body / 2)));
      case "next_panel":
      case "prev_panel": {
        const i = PANELS.indexOf(this.state.list.focus);
        const step = action === "next_panel" ? 1 : PANELS.length - 1;
        this.state.list.focus = PANELS[(i + step) % PANELS.length]!;
        return;
      }
      case "open":
        return this.open();
      case "back":
        this.state.view = "list";
        this.state.detail = null;
        return;
      case "next_section":
      case "prev_section":
        return this.jumpSection(action === "next_section" ? 1 : -1);
      case "toggle_section":
        return this.toggleSection();
      case "open_sections":
      case "fold_sections":
        return this.foldAll(action === "open_sections");
      case "attach":
        return void this.attach();
      case "retry":
        return this.retry();
      case "run_now":
        return this.runNow();
      case "toggle_pause":
        return this.togglePause();
      case "refresh":
        return this.reload();
      case "help":
        this.state.help = true;
        return;
      case "quit":
        return this.quit();
    }
  }

  private quit(): void {
    this.stop();
    this.opts.onQuit();
  }

  private rowsOf(panel: PanelId): number {
    if (!this.dash) return 0;
    return panel === "running" ? this.dash.running.length : panel === "next" ? this.dash.next.length : this.dash.recent.length;
  }

  private move(by: number): void {
    if (this.state.view === "detail" && this.state.detail) return this.moveInRun(by);
    const { list } = this.state;
    const count = this.rowsOf(list.focus);
    const current = list.cursor[list.focus];
    list.cursor[list.focus] = Math.max(0, Math.min(count - 1, by === -Infinity ? 0 : by === Infinity ? count - 1 : current + by));
  }

  /**
   * j/k in a run move between sections, like rows in a list. Inside an open
   * section longer than the screen they scroll it a line at a time until the
   * next (or previous) heading comes into view. Half pages scroll, and
   * select the section being read; gg/G go to the first/last section.
   */
  private moveInRun(by: number): void {
    const d = this.state.detail!;
    const last = d.detail.sections.length - 1;
    const max = maxScroll(d, this.style, this.body);
    if (by === -Infinity || by === Infinity) {
      d.selected = by < 0 ? 0 : last;
      d.scroll = by < 0 ? 0 : max;
      return;
    }
    if (Math.abs(by) === 1) {
      const { starts } = layoutDetail(d, this.style);
      const onScreen = (line: number) => line >= d.scroll && line < d.scroll + this.body;
      if (by > 0) {
        const next = starts[d.selected + 1];
        if (next !== undefined && onScreen(next)) {
          d.selected++;
          this.revealSelected();
        } else d.scroll = Math.min(max, d.scroll + 1);
      } else {
        const here = starts[d.selected]!;
        if (d.selected > 0 && (onScreen(here) || here > d.scroll)) {
          d.selected--;
          this.revealSelected(true);
        } else d.scroll = Math.max(0, d.scroll - 1);
      }
      return;
    }
    d.scroll = Math.max(0, Math.min(max, d.scroll + by));
    // Half a page: the selection follows the section the top line is in.
    if (max > 0) {
      const { starts } = layoutDetail(d, this.style);
      d.selected = Math.max(0, starts.filter((line) => line <= d.scroll).length - 1);
    }
  }

  private jumpSection(direction: 1 | -1): void {
    const d = this.state.detail;
    if (!d) return;
    d.selected = Math.max(0, Math.min(d.detail.sections.length - 1, d.selected + direction));
    this.revealSelected();
  }

  /**
   * Scrolls as little as possible to show the selected section: its heading
   * and as much of what it holds as fits below it, or (`fromBelow`, moving
   * up into a long section) its end, to read it upwards.
   */
  private revealSelected(fromBelow = false): void {
    const d = this.state.detail;
    if (!d) return;
    const { lines, starts } = layoutDetail(d, this.style);
    const head = starts[d.selected] ?? 0;
    const next = starts[d.selected + 1];
    // The section ends before the blank line that sets the next one apart.
    const end = next === undefined ? lines.length - 1 : lines[next - 1] === "" ? next - 2 : next - 1;
    let scroll = d.scroll;
    if (fromBelow) {
      if (head < scroll) scroll = Math.max(head, Math.min(scroll, end - this.body + 1));
    } else {
      if (end >= scroll + this.body) scroll = end - this.body + 1;
      if (head < scroll) scroll = head;
    }
    d.scroll = Math.max(0, Math.min(scroll, maxScroll(d, this.style, this.body)));
  }

  private toggleSection(): void {
    const d = this.state.detail;
    const section = d?.detail.sections[d.selected];
    if (!d || !section) return;
    d.folds[section.id] = !isOpen(d, section);
    this.revealSelected();
  }

  private foldAll(open: boolean): void {
    const d = this.state.detail;
    if (!d) return;
    for (const section of d.detail.sections) d.folds[section.id] = open;
    this.revealSelected();
  }

  /** The selected row: in the list, or the open run. */
  private target(): Target | null {
    if (!this.dash) return null;
    if (this.state.view === "detail" && this.state.detail) {
      const ref = this.state.detail.detail.ref;
      const run = [...this.dash.running, ...this.dash.recent].find((r) => r.ref === ref);
      return run ? { kind: "run", run } : null;
    }
    const { focus, cursor } = this.state.list;
    const i = cursor[focus];
    if (focus === "running") return this.dash.running[i] ? { kind: "run", run: this.dash.running[i] } : null;
    if (focus === "recent") return this.dash.recent[i] ? { kind: "run", run: this.dash.recent[i] } : null;
    const next = this.dash.next[i];
    return next ? { kind: "task", task_id: next.task_id, paused: next.state === "paused" } : null;
  }

  private taskOf(target: Target): string {
    return target.kind === "run" ? target.run.task_id : target.task_id;
  }

  private isPaused(taskId: string): boolean {
    return this.dash?.next.some((n) => n.task_id === taskId && n.state === "paused") ?? false;
  }

  private flash(text: string, error = false): void {
    this.state.flash = { text, error };
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.state.flash = null;
      this.draw();
    }, FLASH_MS);
  }

  private open(): void {
    const target = this.target();
    if (!target || !this.dash) return;
    let ref: string | undefined;
    if (target.kind === "run") ref = target.run.ref;
    else {
      // A task in Next: its latest run.
      ref = [...this.dash.running, ...this.dash.recent].filter((r) => r.task_id === target.task_id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.ref;
      if (!ref) return this.flash(`${target.task_id} has no runs yet`);
    }
    try {
      this.state.detail = { detail: buildRunDetail(this.ctx, this.style, ref, this.width), scroll: 0, selected: 0, folds: {} };
      this.state.view = "detail";
    } catch (err) {
      this.flash((err as Error).message, true);
    }
  }

  private ask(question: string, then: () => void): void {
    this.state.confirm = question;
    this.confirmed = then;
  }

  /** Runs a command in the background of the screen and shows its first line of output. */
  private async background(args: string[], doing: string): Promise<void> {
    this.flash(`${doing}…`);
    this.draw();
    const { code, output } = await this.opts.exec(args, { interactive: false });
    const first = output.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    this.flash(code === 0 ? first || `${doing}: done` : `${doing} failed: ${first || `exit code ${code}`}`, code !== 0);
    this.reload();
  }

  private retry(): void {
    const target = this.target();
    if (!target) return;
    if (target.kind !== "run" || !["failed", "timed_out", "missed"].includes(target.run.status)) {
      return this.flash("only failed, timed-out or missed runs can be retried", true);
    }
    const ref = target.run.ref;
    this.ask(`Retry ${ref}? It launches a new agent now.`, () => void this.background(["retry", ref], `retrying ${ref}`));
  }

  private runNow(): void {
    const target = this.target();
    if (!target) return;
    const id = this.taskOf(target);
    this.ask(`Run ${id} now? It launches a new agent outside its schedule.`, () => void this.background(["run", id], `starting ${id}`));
  }

  private togglePause(): void {
    const target = this.target();
    if (!target) return;
    const id = this.taskOf(target);
    const paused = target.kind === "task" ? target.paused : this.isPaused(id);
    void this.background([paused ? "resume" : "pause", id], paused ? `resuming ${id}` : `pausing ${id}`);
  }

  /** Hands the terminal to `agent-tasks attach` and takes it back when it ends. */
  private async attach(): Promise<void> {
    const target = this.target();
    if (!target) return;
    if (target.kind !== "run" || !isInProgress(target.run.status)) {
      return this.flash(`only running or blocked runs have a session to attach to; open the run to read its log`, true);
    }
    this.suspended = true;
    this.leaveScreen();
    let code: number;
    try {
      ({ code } = await this.opts.exec(["attach", target.run.ref], { interactive: true }));
    } catch (err) {
      code = 1;
      this.opts.terminal.write(`agent-tasks: ${(err as Error).message}\n`);
    }
    if (code !== 0) {
      // Leave its error on screen until a key is pressed.
      this.opts.terminal.write("\nPress any key to go back to the dashboard…");
      await new Promise<void>((resolve) => {
        const stop = this.opts.terminal.readInput(() => {
          stop();
          resolve();
        });
      });
    }
    this.suspended = false;
    if (!this.running) return;
    this.enterScreen();
    this.reload();
  }
}

// ---------------------------------------------------------------------------
// The real terminal and commands
// ---------------------------------------------------------------------------

export function processTerminal(): TuiTerminal {
  const { stdin, stdout } = process;
  return {
    write: (text) => stdout.write(text),
    size: () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }),
    onResize(listener) {
      stdout.on("resize", listener);
      return () => stdout.off("resize", listener);
    },
    readInput(listener) {
      const onData = (chunk: Buffer | string) => listener(chunk.toString());
      stdin.setRawMode?.(true);
      stdin.on("data", onData);
      stdin.resume();
      return () => {
        stdin.off("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
      };
    },
  };
}

/** This same CLI: `bun <path to bin/agent-tasks>` (no `--now`: actions happen now). */
export function selfCommand(env: Record<string, string | undefined>): CommandRunner {
  const base = [process.execPath, process.argv[1]!];
  return async (args, { interactive }) => {
    const proc = Bun.spawn([...base, ...args], {
      env: { ...process.env, ...env },
      stdin: interactive ? "inherit" : "ignore",
      stdout: interactive ? "inherit" : "pipe",
      stderr: interactive ? "inherit" : "pipe",
    });
    if (interactive) return { code: await proc.exited, output: "" };
    const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    return { code, output: code === 0 ? out || err : err || out };
  };
}
