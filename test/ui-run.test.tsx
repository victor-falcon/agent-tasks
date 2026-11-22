import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import type { Run } from "../src/schema.ts";
import { readRunByRef, writeRun } from "../src/store.ts";
import type { CommandRunner } from "../src/tui/app.ts";
import { buildKeymap } from "../src/ui/keymap/config.ts";
import { type AppHandle, mountApp } from "../src/ui/main.tsx";
import { buildRunModel, type Geometry, logSegments, matchRows, moveInRun, nextMatch, reveal } from "../src/ui/views/run/model.ts";
import { FIXTURE_NOW, FIXTURE_TZ, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// The Run detail of the new dashboard (src/ui/views/run): its sections and
// folds, moving and scrolling, the log search, the actions and the mouse, on
// OpenTUI's test renderer; and its pure model. Commands go to a fake runner.

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };
const FAILED = "sentry-summary/20261117T080000Z";
const BLOCKED = "review-pr-123/20261117T083000Z";
const RUNNING = "sentry-summary/20261117T090000Z";

let home: TempHome;
let handle: AppHandle | null = null;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
  writeFixture(home.paths);
});
afterEach(() => {
  handle?.stop();
  handle = null;
  home.cleanup();
});

const ctx = () => createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands });

/** Rewrites a fixture run. */
function editRun(ref: string, change: (run: Run) => void): Run {
  const run = readRunByRef(home.paths, ref);
  change(run);
  writeRun(home.paths, run);
  return run;
}

function writeData(relative: string, text: string): string {
  const file = join(home.dataDir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** A log of `n` numbered lines for the failed run. */
function longLog(n: number): void {
  writeData("runs/sentry-summary/20261117T080000Z.log", Array.from({ length: n }, (_, i) => `line ${i + 1}${i === 70 ? " error: boom" : ""}`).join("\n"));
}

interface Started {
  setup: TestRendererSetup;
  handle: AppHandle;
  calls: { args: string[]; interactive: boolean }[];
  spawned: string[][];
  screen(): Promise<string>;
  press(...keys: string[]): Promise<void>;
  /** The heading drawn inverse (the selected section), trimmed to its name. */
  selected(): Promise<string>;
}

async function start(ref: string, opts: { width?: number; height?: number; exec?: CommandRunner } = {}): Promise<Started> {
  const setup = await createTestRenderer({ width: opts.width ?? 100, height: opts.height ?? 30 });
  const calls: Started["calls"] = [];
  const spawned: string[][] = [];
  handle = await mountApp(setup.renderer, {
    title: "agent-tasks top",
    config: { keymap: buildKeymap(), mouse: true, file: null },
    now: () => NOW,
    context: (now) => createContext({ now, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands }),
    env: { ...home.env, PAGER: "less -R" },
    exec: async (args, o) => {
      calls.push({ args, interactive: o.interactive });
      return opts.exec ? opts.exec(args, o) : { code: 0, output: `did ${args.join(" ")}\n` };
    },
    watchDir: null,
    onQuit: () => {},
    waitForKey: async () => {},
    handOver: { suspend: async () => {}, resume: async () => {} },
    spawn: async (argv) => {
      spawned.push(argv);
      return 0;
    },
  });
  handle.app.ui.push({ view: "run", params: { ref } });
  // Layout reads (afterLayout) settle over a couple of frames.
  const frames = async () => {
    for (let i = 0; i < 3; i++) await setup.renderOnce();
  };
  const screen = async () => {
    await frames();
    return setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      if (key === "<CR>") setup.mockInput.pressEnter();
      else if (key === "<Esc>") {
        setup.mockInput.pressEscape();
        await Bun.sleep(60);
      } else if (key === "<BS>") setup.mockInput.pressBackspace();
      else if (key === "<C-d>") setup.mockInput.pressKey("d", { ctrl: true });
      else if (/^[A-Z]$/.test(key)) setup.mockInput.pressKey(key.toLowerCase(), { shift: true });
      else setup.mockInput.pressKey(key);
      await Bun.sleep(1);
      await frames();
    }
  };
  const selected = async () => {
    await frames();
    for (const line of setup.captureSpans().lines) {
      const span = line.spans.find((s) => s.attributes & TextAttributes.INVERSE && /[▾▸]/.test(s.text));
      if (span) return span.text.replace(/^[▾▸] /, "").replace(/[ ─].*$/, "");
    }
    return "";
  };
  await frames();
  return { setup, handle, calls, spawned, screen, press, selected };
}

/** Waits for background commands (the fake runner resolves on the next tick). */
const settle = () => Bun.sleep(5);

describe("sections", () => {
  test("title, Result open with the summary, the rest folded", async () => {
    const { screen, selected } = await start(FAILED);
    const text = await screen();
    expect(text).toMatchSnapshot();
    expect(text).toContain("sentry-summary/20261117T080000Z  ✕ failed · 3m");
    expect(text).toContain("▾ Result");
    expect(text).toContain("✕ failed · Nov 17 09:00 · took 3m · attempt 2");
    expect(text).toContain("sentry-cli has no auth");
    for (const name of ["Details", "Attempts", "Events", "Log"]) expect(text).toContain(`▸ ${name}`);
    expect(await selected()).toBe("Result");
  });

  test("a run without a result opens its log; one in progress ticks", async () => {
    editRun(RUNNING, () => {});
    writeData("runs/sentry-summary/20261117T090000Z.log", "working on it\n");
    const { screen } = await start(RUNNING);
    const text = await screen();
    expect(text).toContain("◐ running · 1m so far");
    expect(text).toContain("Still in progress: the agent reports its result when it finishes. Its log is below.");
    expect(text).toContain("▾ Log · 1 line");
    expect(text).toContain("working on it");
  });

  test("the output file: Markdown for .md, code otherwise; a gone file says so", async () => {
    editRun(FAILED, (run) => void (run.attempts.at(-1)!.output = "runs/sentry-summary/out.md"));
    writeData("runs/sentry-summary/out.md", "# Report\n\n- **3** issues\n");
    let model = buildRunModel(ctx(), FAILED, FIXTURE_TZ);
    expect(model.sections.map((s) => [s.id, s.open])).toEqual([["result", true], ["output", true], ["details", false], ["attempts", false], ["events", false], ["log", false]]);
    expect(model.sections[1]!.blocks).toEqual([{ kind: "markdown", text: "# Report\n\n- **3** issues" }]);
    const { screen } = await start(FAILED);
    const text = await screen();
    expect(text).toContain("▾ Output · ~/data/runs/sentry-summary/out.md");
    expect(text).toContain("Report");
    expect(text).not.toContain("**3**");

    editRun(FAILED, (run) => void (run.attempts.at(-1)!.output = "runs/sentry-summary/out.ts"));
    writeData("runs/sentry-summary/out.ts", "const x = 1;\n");
    model = buildRunModel(ctx(), FAILED, FIXTURE_TZ);
    expect(model.sections[1]!.blocks).toEqual([{ kind: "code", text: "const x = 1;", filetype: "typescript" }]);
    editRun(FAILED, (run) => void (run.attempts.at(-1)!.output = "runs/sentry-summary/gone.txt"));
    model = buildRunModel(ctx(), FAILED, FIXTURE_TZ);
    expect(model.sections[1]!.blocks).toEqual([{ kind: "lines", lines: [[{ text: "(the file is gone)", color: "dim" }]] }]);
  });

  test("a blocked run says it waits for you, with the attach key", async () => {
    const { screen } = await start(BLOCKED);
    expect(await screen()).toContain("│ Waiting for you. a attach to its session");
  });

  test("a run that is gone says so", async () => {
    const { screen } = await start("sentry-summary/20991117T080000Z");
    expect(await screen()).toContain("sentry-summary/20991117T080000Z");
  });
});

describe("keys", () => {
  test("j/k and { } move between sections, <CR> and za fold, zR/zM all, gg/G", async () => {
    const { screen, press, selected } = await start(FAILED, { height: 40 });
    await press("j");
    expect(await selected()).toBe("Details");
    await press("}", "}");
    expect(await selected()).toBe("Events");
    await press("{");
    expect(await selected()).toBe("Attempts");
    await press("<CR>");
    expect(await screen()).toContain("▾ Attempts");
    expect(await screen()).toContain("Attempt 1 · ✕ failed · started 09:02 · 2m");
    await press("z", "a");
    expect(await screen()).toContain("▸ Attempts");
    await press("z", "R");
    let text = await screen();
    for (const name of ["Result", "Details", "Attempts", "Events", "Log"]) expect(text).toContain(`▾ ${name}`);
    await press("z", "M");
    text = await screen();
    for (const name of ["Result", "Details", "Attempts", "Events", "Log"]) expect(text).toContain(`▸ ${name}`);
    await press("G");
    expect(await selected()).toBe("Log");
    await press("g", "g");
    expect(await selected()).toBe("Result");
  });

  test("j scrolls through a long open section before moving on; k comes back", async () => {
    longLog(120);
    const { screen, press, selected } = await start(FAILED);
    await press("G", "<CR>"); // open the log at the end
    expect(await selected()).toBe("Log");
    await press("g", "g");
    expect(await selected()).toBe("Result");
    await press("j", "j", "j", "j"); // Details, Attempts, Events, Log: all headings on screen
    expect(await selected()).toBe("Log");
    const before = await screen();
    await press("j"); // no heading below: scrolls (the log's heading goes off the top)
    const after = await screen();
    expect(after).not.toBe(before);
    await press("<C-d>"); // half a page down: the heading goes
    expect(await screen()).not.toContain("▾ Log");
    await press("G");
    expect(await screen()).toContain("line 120");
    await press("k"); // the log's heading is far above: scrolls up a row
    const text = await screen();
    expect(text).toContain("line 119");
    expect(text).not.toContain("line 120");
  });

  test("/ searches the log: the match shows, n and N move between matches", async () => {
    longLog(120);
    const { screen, press, selected } = await start(FAILED);
    await press("/", "b", "o", "o", "x", "<BS>", "m");
    expect(await screen()).toContain("/boom█");
    await press("<CR>");
    const text = await screen();
    expect(text).toContain("line 71 error: boom");
    expect(text).toContain("/boom  1 of 1");
    await press("/", "l", "i", "n", "e", " ", "1", "1", "<CR>");
    expect(await screen()).toContain("/line 11  1 of 11");
    await press("n");
    expect(await screen()).toContain("2 of 11");
    await press("N", "N");
    expect(await screen()).toContain("11 of 11");
    await press("/", "x", "<Esc>"); // cancelled: the last search stays
    expect(await screen()).toContain("/line 11  11 of 11");
  });

  test("searching a run without a log says so; keys typed in a search are not actions", async () => {
    const { screen, press, calls } = await start("inbox-triage/20261117T050000Z");
    await press("/");
    expect(await screen()).toContain("this run has no log to search");
    const second = await start(FAILED);
    await second.press("/", "r", "<CR>");
    expect(second.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a reload keeps the folds, the selection and the scroll", async () => {
    const { screen, press, selected, handle: h } = await start(FAILED);
    await press("j", "j", "<CR>");
    expect(await selected()).toBe("Attempts");
    editRun(FAILED, (run) => run.events.push({ at: "2026-11-17T09:20:00Z", event: "notified" }));
    h.app.store.reload();
    const text = await screen();
    expect(text).toContain("▾ Attempts");
    expect(text).toContain("▸ Events · 3 events · last: notified");
    expect(await selected()).toBe("Attempts");
  });

  test("t goes to the task; back finds the run as it was", async () => {
    const { screen, press, selected } = await start(FAILED);
    await press("j", "<CR>");
    await press("t");
    expect(await screen()).toContain("Task sentry-summary is not in the new dashboard yet.");
    await press("h");
    expect(await screen()).toContain("▾ Details");
    expect(await selected()).toBe("Details");
  });
});

describe("actions", () => {
  test("a attaches, r retries after asking, R runs the task after asking", async () => {
    const { screen, press, calls } = await start(FAILED);
    await press("a");
    expect(await screen()).toContain("only running or blocked runs have a session");
    await press("<Esc>"); // dismisses the error (it does not leave the run)
    expect(await screen()).not.toContain("only running or blocked");
    expect(await screen()).toContain("▾ Result");
    await press("r");
    expect(await screen()).toContain(`Retry ${FAILED}?`);
    await press("y");
    await settle();
    await press("R");
    expect(await screen()).toContain("Run sentry-summary now?");
    await press("y");
    await settle();
    expect(calls).toEqual([
      { args: ["retry", FAILED], interactive: false },
      { args: ["run", "sentry-summary"], interactive: false },
    ]);
    const blocked = await start(BLOCKED);
    await blocked.press("a");
    await settle();
    expect(blocked.calls).toEqual([{ args: ["attach", BLOCKED], interactive: true }]);
  });

  test("c closes an open session after asking; a closed one says why not", async () => {
    const { screen, press, calls } = await start(FAILED);
    await press("c");
    expect(await screen()).toContain(`Close the session of ${FAILED}?`);
    expect(await screen()).toContain("It closes p28; the run's status does not change.");
    await press("y");
    await settle();
    expect(calls).toEqual([{ args: ["session", "close", FAILED], interactive: false }]);
    editRun(FAILED, (run) => void (run.attempts.at(-1)!.session!.closed_at = "2026-11-17T09:20:00Z"));
    await press("c");
    expect(await screen()).toContain("only a run whose session is still open");
    expect(calls.length).toBe(1);
  });

  test("o opens the output in $PAGER; y and Y copy the ref and the summary", async () => {
    editRun(FAILED, (run) => void (run.attempts.at(-1)!.output = "runs/sentry-summary/out.md"));
    const file = writeData("runs/sentry-summary/out.md", "# Report\n");
    const { screen, press, spawned, setup } = await start(FAILED);
    await press("o");
    await settle();
    expect(spawned).toEqual([["sh", "-c", 'less -R "$1"', "sh", file]]);
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text: string) => (copied.push(text), true);
    await press("y");
    expect(await screen()).toContain("copied the ref");
    await press("Y");
    expect(copied).toEqual([FAILED, "sentry-cli has no auth"]);
  });
});

describe("mouse", () => {
  test("a click on a heading folds or opens it", async () => {
    const { screen, setup, selected } = await start(FAILED);
    const text = await screen();
    const y = text.split("\n").findIndex((l) => l.includes("▸ Events"));
    await setup.mockMouse.click(5, y);
    expect(await screen()).toContain("▾ Events");
    expect(await selected()).toBe("Events");
  });
});

describe("model", () => {
  // Five sections: Result (rows 0-4), Details (6), Attempts (7), Events (8), Log (10-59), a view of 10 rows.
  const g: Geometry = { starts: [0, 6, 7, 8, 10], ends: [4, 6, 7, 8, 59], viewport: 10, total: 60 };

  test("j/k move between headings on screen and scroll a long section", () => {
    expect(moveInRun(g, { selected: 0, scroll: 0 }, 1)).toEqual({ selected: 1, scroll: 0 });
    // Log's heading is just below the view: scroll a row; then it shows and is selected, shown as far as it fits.
    expect(moveInRun(g, { selected: 3, scroll: 0 }, 1)).toEqual({ selected: 3, scroll: 1 });
    expect(moveInRun(g, { selected: 3, scroll: 1 }, 1)).toEqual({ selected: 4, scroll: 10 });
    // No heading below: scroll a row.
    expect(moveInRun(g, { selected: 4, scroll: 10 }, 1)).toEqual({ selected: 4, scroll: 11 });
    expect(moveInRun(g, { selected: 4, scroll: 50 }, 1)).toEqual({ selected: 4, scroll: 50 });
    // k inside the log scrolls up until its heading shows, then moves on.
    expect(moveInRun(g, { selected: 4, scroll: 11 }, -1)).toEqual({ selected: 4, scroll: 10 });
    expect(moveInRun(g, { selected: 4, scroll: 10 }, -1)).toEqual({ selected: 3, scroll: 8 });
    // Half pages select the section being read; ±Infinity go to the ends.
    expect(moveInRun(g, { selected: 0, scroll: 0 }, 7)).toEqual({ selected: 2, scroll: 7 });
    expect(moveInRun(g, { selected: 2, scroll: 30 }, Number.NEGATIVE_INFINITY)).toEqual({ selected: 0, scroll: 0 });
    expect(moveInRun(g, { selected: 0, scroll: 0 }, Number.POSITIVE_INFINITY)).toEqual({ selected: 4, scroll: 50 });
    // A selection scrolled out of view (the wheel) moves to the section being read first.
    expect(moveInRun(g, { selected: 0, scroll: 30 }, 1)).toEqual({ selected: 4, scroll: 31 });
  });

  test("reveal shows the heading and as much as fits, or the end from below", () => {
    expect(reveal(g, { selected: 4, scroll: 0 })).toBe(10);
    expect(reveal(g, { selected: 0, scroll: 20 })).toBe(0);
    expect(reveal(g, { selected: 4, scroll: 55 }, true)).toBe(50);
  });

  test("search: smart case, wrapping around, the log as few segments", () => {
    const rows = ["Error here", "fine", "error again", "fine"];
    expect(matchRows(rows, "error")).toEqual([0, 2]);
    expect(matchRows(rows, "Error")).toEqual([0]);
    expect(matchRows(rows, "")).toEqual([]);
    expect(nextMatch([0, 2], 2, 1)).toBe(0);
    expect(nextMatch([0, 2], 0, -1)).toBe(2);
    expect(nextMatch([], 0, 1)).toBeNull();
    expect(logSegments(rows, [2], 2)).toEqual([{ text: "Error here\nfine\n" }, { text: "error again", color: "inverse" }, { text: "\n" }, { text: "fine" }]);
    expect(logSegments(rows, [], null).map((s) => s.text).join("")).toBe(rows.join("\n"));
  });

  test("the run as the actions see it, and the session in Details", () => {
    const model = buildRunModel(ctx(), FAILED, FIXTURE_TZ);
    expect(model.target).toMatchObject({ ref: FAILED, task_id: "sentry-summary", status: "failed", attempt: 2 });
    expect(model.summary).toBe("sentry-cli has no auth");
    const details = model.sections.find((s) => s.id === "details")!.blocks[0]!;
    expect(JSON.stringify(details)).toContain("process p28 (open)");
  });
});
