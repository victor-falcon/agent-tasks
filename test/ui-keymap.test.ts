import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../src/errors.ts";
import { ACTIONS as V1_ACTIONS, loadKeymap } from "../src/tui/keys.ts";
import { ACTIONS, DEFAULT_KEYS } from "../src/ui/keymap/actions.ts";
import { buildKeymap, loadTuiConfig } from "../src/ui/keymap/config.ts";
import { countedBinding, strokeOf } from "../src/ui/keymap/vim.ts";
import { VIEW_KEYS } from "../src/ui/views/keys.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// tui.toml for the new dashboard (src/ui): a file written for the old one
// keeps working, with the same notation and the same errors; the new actions
// and `mouse` are accepted by both.

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

const writeToml = (text: string) => writeFileSync(join(home.configDir, "tui.toml"), text);

/** The error details of a loader, or null when it loads. */
function details(load: () => unknown): string[] | null {
  try {
    load();
    return null;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.details;
  }
}

describe("tui.toml", () => {
  test("every action of the old dashboard keeps its name and default keys", () => {
    for (const action of Object.keys(V1_ACTIONS)) expect(action in ACTIONS).toBe(true);
    const keymap = buildKeymap();
    expect(keymap.down.map((b) => b.text)).toEqual(["j", "<Down>"]);
    expect(keymap.next_tab.map((b) => b.text)).toEqual(["gt"]);
  });

  test("an old file loads the same way: overrides replace defaults, [] unbinds", () => {
    writeToml('[keys]\ndown = ["n", "<Down>"]\nretry = "<C-r>"\nrun_now = []\n');
    const config = loadTuiConfig(home.configDir);
    expect(config.file).toBe(join(home.configDir, "tui.toml"));
    expect(config.keymap.down.map((b) => b.keys)).toEqual([["n"], ["<Down>"]]);
    expect(config.keymap.retry.map((b) => b.text)).toEqual(["<C-r>"]);
    expect(config.keymap.run_now).toEqual([]);
    expect(config.mouse).toBe(true);
  });

  test("broken files fail with the old loader's words", () => {
    const cases = [
      '[keys]\nretry = "<Nope>"\n',
      '[keys]\nnope = "x"\n',
      "[keys]\nretry = 3\n",
      '[keys]\nretry = "j"\n', // j is down in the list views
      '[keys]\nfirst = "g"\nnext_panel = "gj"\n', // g hides gj
      "keys = 3\n",
      "not toml [",
    ];
    for (const text of cases) {
      writeToml(text);
      const theirs = details(() => loadKeymap(home.configDir));
      const ours = details(() => loadTuiConfig(home.configDir));
      expect(ours).not.toBeNull();
      if (text.includes("nope")) {
        // The list of known actions is longer here.
        expect(ours![0]).toStartWith("keys.nope: unknown action (known: down, up,");
        continue;
      }
      // The old dashboard names its views list/detail (and may say it for both); the rest is the same message.
      const message = (all: string[]) => [...new Set(all.map((d) => d.replace(/ in the \w+ view$/, "")))];
      expect(message(ours!)).toEqual(message(theirs!));
    }
  });

  test("conflicts are checked within each view, as the keys it listens to", () => {
    writeToml('[keys]\nundo = "j"\n');
    // Every list view binds both and reports it; the overview is one of them.
    expect(details(() => loadTuiConfig(home.configDir))).toContain('"j" is bound to both undo and down in the overview view');
    // `back` lives in the detail views, `dismiss` in the roots: both on <Esc> is fine.
    expect(() => buildKeymap({ back: "<Esc>", dismiss: "<Esc>" })).not.toThrow();
  });

  test("an old file's key wins over a new action's default key", () => {
    writeToml('[keys]\nretry = "u"\nattach = "1"\nrun_now = "gt"\n');
    const config = loadTuiConfig(home.configDir);
    expect(config.keymap.retry.map((b) => b.text)).toEqual(["u"]);
    expect(config.keymap.undo).toEqual([]);
    expect(config.keymap.tab_overview).toEqual([]);
    expect(config.keymap.next_tab).toEqual([]);
    expect(config.keymap.prev_tab.map((b) => b.text)).toEqual(["gT"]);
    // `g` alone would hide gt and gT: they give way too.
    writeToml('[keys]\nfirst = "g"\n');
    expect(loadTuiConfig(home.configDir).keymap.prev_tab).toEqual([]);
    // Set both, and the clash is reported as usual.
    writeToml('[keys]\nretry = "u"\nundo = "u"\n');
    expect(details(() => loadTuiConfig(home.configDir))).toContain('"u" is bound to both undo and retry in the overview view');
  });

  test("new actions and mouse = false; the old dashboard reads the same file", () => {
    writeToml('mouse = false\n\n[keys]\nnext_tab = "L"\ndown = "j"\n');
    const config = loadTuiConfig(home.configDir);
    expect(config.mouse).toBe(false);
    expect(config.keymap.next_tab.map((b) => b.text)).toEqual(["L"]);
    const old = loadKeymap(home.configDir);
    expect(old.keymap.down.map((b) => b.text)).toEqual(["j"]);
  });

  test("mouse must be a boolean; other settings are unknown", () => {
    writeToml('mouse = "no"\n');
    expect(details(() => loadTuiConfig(home.configDir))).toEqual(["mouse: expected true or false"]);
    writeToml("colors = 1\n");
    expect(details(() => loadTuiConfig(home.configDir))).toEqual(["colors: unknown setting (only [keys] and mouse are read)"]);
  });

  test("the defaults have no conflicts in any view", () => {
    expect(() => buildKeymap({}, VIEW_KEYS)).not.toThrow();
    for (const view of VIEW_KEYS) for (const action of view.actions) expect(DEFAULT_KEYS[action]).toBeDefined();
  });
});

describe("Vim notation on the keymap", () => {
  test("keys become the strokes the terminal sends", () => {
    expect(strokeOf("g")).toEqual({ name: "g" });
    expect(strokeOf("G")).toEqual({ name: "g", shift: true });
    expect(strokeOf("<C-d>")).toEqual({ name: "d", ctrl: true });
    expect(strokeOf("<S-Tab>")).toEqual({ name: "tab", shift: true });
    expect(strokeOf("<CR>")).toEqual({ name: "return" });
    expect(strokeOf("<Esc>")).toEqual({ name: "escape" });
    expect(strokeOf("<PageDown>")).toEqual({ name: "pagedown" });
    expect(strokeOf("?")).toEqual({ name: "?" });
    expect(strokeOf("<")).toEqual({ name: "<" });
  });

  test("single keys take a count, sequences do not", () => {
    expect(countedBinding("j")).toBe("{count}j");
    expect(countedBinding("<Down>")).toBe("{count}<Down>");
    expect(countedBinding("gj")).toBeNull();
  });
});
