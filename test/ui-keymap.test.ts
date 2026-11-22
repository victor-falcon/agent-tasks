import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ConfigError } from "../src/errors.ts";
import { ACTIONS, type Action, DEFAULT_KEYS } from "../src/ui/keymap/actions.ts";
import { buildKeymap, loadTuiConfig } from "../src/ui/keymap/config.ts";
import { isNewAction } from "../src/ui/keymap/new-actions.ts";
import { parseKeys } from "../src/ui/keymap/notation.ts";
import { GLOBAL_ACTIONS, LIST_ACTIONS } from "../src/ui/keymap/spec.ts";
import type { KeyEvent } from "@opentui/core";
import { isKey, strokeOf } from "../src/ui/keymap/vim.ts";
import { VIEW_KEYS } from "../src/ui/views/keys.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// tui.toml: Vim notation, the keymap it builds, its errors (a file written
// for the first dashboard keeps working and fails with the same words),
// `config check`, and examples/tui.example.toml, which lists every action.

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

/** The first dashboard's actions: tui.toml files written for it use these names. */
const FIRST_ACTIONS = ["down", "up", "first", "last", "half_page_down", "half_page_up", "next_panel", "prev_panel", "open", "back", "next_section", "prev_section", "toggle_section", "open_sections", "fold_sections", "attach", "retry", "run_now", "toggle_pause", "refresh", "help", "quit"];

describe("key notation", () => {
  test("bindings split into canonical keys", () => {
    expect(parseKeys("j")).toEqual(["j"]);
    expect(parseKeys("gg")).toEqual(["g", "g"]);
    expect(parseKeys("<C-w>j")).toEqual(["<C-w>", "j"]);
    expect(parseKeys("<c-D>")).toEqual(["<C-d>"]);
    expect(parseKeys("<enter>")).toEqual(["<CR>"]);
    expect(parseKeys("<s-tab>")).toEqual(["<S-Tab>"]);
    expect(parseKeys("<lt>")).toEqual(["<"]);
    expect(parseKeys("}")).toEqual(["}"]);
  });

  test("unknown keys are refused", () => {
    expect(() => parseKeys("<Foo>")).toThrow("unknown key <Foo>");
    expect(() => parseKeys("<C-1>")).toThrow("only <C-a> to <C-z>");
    expect(() => parseKeys("g g")).toThrow("<Space>");
    expect(() => parseKeys("<C-d")).toThrow('"<" without a closing ">"');
  });
});

describe("tui.toml", () => {
  test("every action of the first dashboard keeps its name and default keys", () => {
    for (const action of FIRST_ACTIONS) {
      expect(action in ACTIONS).toBe(true);
      expect(isNewAction(action)).toBe(false);
    }
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

  test("broken files fail with the first dashboard's words", () => {
    const known = "(known: <CR>, <Esc>, <Tab>, <S-Tab>, <BS>, <Space>, <Up>, <Down>, <Left>, <Right>, <Home>, <End>, <PageUp>, <PageDown>, <Del>, <C-a>…<C-z>)";
    const cases: [string, string[]][] = [
      ['[keys]\nretry = "<Nope>"\n', [`keys.retry: "<Nope>": unknown key <Nope> ${known}`]],
      ["[keys]\nretry = 3\n", ['keys.retry: expected a key or a list of keys, e.g. "j" or ["j", "<Down>"]']],
      ["keys = 3\n", ["keys: must be a table, e.g. [keys]"]],
      ["not toml [", ["invalid TOML: TOML Parse error: Expected '=' after a key but found 't'"]],
    ];
    for (const [text, expected] of cases) {
      writeToml(text);
      expect(details(() => loadTuiConfig(home.configDir))).toEqual(expected);
    }
    writeToml('[keys]\nnope = "x"\n');
    expect(details(() => loadTuiConfig(home.configDir))![0]).toStartWith("keys.nope: unknown action (known: down, up,");
    // Conflicts name the view they happen in (every list view binds j).
    writeToml('[keys]\nretry = "j"\n');
    expect(details(() => loadTuiConfig(home.configDir))).toContain('"j" is bound to both down and retry in the overview view');
    writeToml('[keys]\nfirst = "g"\nnext_panel = "gj"\n');
    expect(details(() => loadTuiConfig(home.configDir))).toContain('"g" (first) hides "gj" (next_panel); it is bound to first and next_panel in the overview view');
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

  test("new actions and mouse = false", () => {
    writeToml('mouse = false\n\n[keys]\nnext_tab = "L"\ndown = "j"\n');
    const config = loadTuiConfig(home.configDir);
    expect(config.mouse).toBe(false);
    expect(config.keymap.next_tab.map((b) => b.text)).toEqual(["L"]);
    expect(config.keymap.down.map((b) => b.text)).toEqual(["j"]);
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

  test("a key event is matched against a single key of tui.toml, never a sequence", () => {
    const key = (name: string, mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}) => ({ name, ctrl: false, shift: false, meta: false, ...mods }) as KeyEvent;
    expect(isKey(key("j"), "j")).toBe(true);
    expect(isKey(key("down"), "<Down>")).toBe(true);
    expect(isKey(key("g", { shift: true }), "G")).toBe(true);
    expect(isKey(key("g"), "G")).toBe(false);
    expect(isKey(key("d", { ctrl: true }), "<C-d>")).toBe(true);
    expect(isKey(key("d"), "<C-d>")).toBe(false);
    expect(isKey(key("j", { meta: true }), "j")).toBe(false);
    expect(isKey(key("g"), "gg")).toBe(false);
  });
});

describe("config check", () => {
  test("validates tui.toml when there is one", async () => {
    const check = async () => {
      let stdout = "";
      await main(["config", "check", "--json"], { env: home.env, cwd: home.root, stdout: { write: (t) => void (stdout += t) }, stderr: { write: () => {} } });
      return (JSON.parse(stdout).checks as { id: string; status: string; details?: string[] }[]).filter((c) => c.id === "config.tui");
    };
    expect(await check()).toEqual([]);
    writeToml('mouse = false\n[keys]\nretry = "<C-r>"\nnext_tab = "L"\n');
    expect((await check()).map((c) => c.status)).toEqual(["ok"]);
    writeToml('[keys]\nretry = "<Nope>"\n');
    const [failed] = await check();
    expect(failed!.status).toBe("error");
    expect(failed!.details![0]).toContain("unknown key <Nope>");
  });
});

// examples/tui.example.toml is generated from the keymap: every action with
// its default keys and description, grouped by where it works. When an action
// or a default key changes, regenerate it:
//   UPDATE_EXAMPLES=1 bun test test/ui-keymap.test.ts

const EXAMPLE = join(import.meta.dir, "..", "examples", "tui.example.toml");

const EXAMPLE_HEADER = `# Settings of the dashboard (\`agent-tasks top\`, and \`agent-tasks runner\` on a
# terminal). Copy to ~/.config/agent-tasks/tui.toml and keep only what you
# change: an action you set replaces its default keys, \`[]\` unbinds it.
# \`agent-tasks config check\` validates the file.
#
# Keys use Vim notation: j, G, gg (one key after the other), <C-d>, <CR>,
# <Esc>, <Tab>, <S-Tab>, <BS>, <Space>, <Up>, <Down>, <Left>, <Right>,
# <Home>, <End>, <PageUp>, <PageDown>, <C-w>j, <lt> for "<". Ctrl-C always
# quits. Press ? in the dashboard to see the keys of the view you are in.
#
# This file is generated from the keymap (test/ui-keymap.test.ts): these are
# the defaults.

# The mouse is on: clicks select, a double click opens, the wheel scrolls.
# Uncomment to leave it to the terminal (to select text, for one):
# mouse = false

[keys]
`;

const VIEW_TITLES: Record<string, string> = { overview: "Overview tab", tasks: "Tasks tab", runs: "Runs tab", system: "System tab", run: "Run detail", task: "Task detail" };

function renderExample(): string {
  const groups: [string, readonly Action[]][] = [
    ["Everywhere", GLOBAL_ACTIONS],
    ["Moving in a list", LIST_ACTIONS],
    ...VIEW_KEYS.map((v): [string, readonly Action[]] => [VIEW_TITLES[v.id] ?? v.id, v.actions]),
  ];
  const listed = new Set<Action>();
  const sections: string[] = [];
  for (const [title, actions] of groups) {
    const fresh = actions.filter((a) => !listed.has(a));
    if (fresh.length === 0) continue;
    for (const a of fresh) listed.add(a);
    const lines = fresh.map((a) => [`${a} = [${DEFAULT_KEYS[a].map((k) => JSON.stringify(k)).join(", ")}]`, ACTIONS[a]] as const);
    const width = Math.max(...lines.map(([l]) => l.length));
    sections.push([`# ${title}`, ...lines.map(([l, desc]) => `${l.padEnd(width)}  # ${desc}`)].join("\n"));
  }
  return `${EXAMPLE_HEADER}${sections.join("\n\n")}\n`;
}

describe("examples/tui.example.toml", () => {
  test("lists every action with its default keys, and mouse", () => {
    const expected = renderExample();
    if (process.env.UPDATE_EXAMPLES === "1") writeFileSync(EXAMPLE, expected);
    expect(readFileSync(EXAMPLE, "utf8")).toBe(expected);
    const parsed = Bun.TOML.parse(expected) as { keys: Record<string, string[]> };
    expect(parsed.keys).toEqual(Object.fromEntries(Object.entries(DEFAULT_KEYS).map(([a, keys]) => [a, [...keys]])));
  });

  test("loads as a tui.toml, and with mouse = false uncommented", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    writeToml(text);
    expect(loadTuiConfig(home.configDir).mouse).toBe(true);
    writeToml(text.replace("# mouse = false", "mouse = false"));
    expect(loadTuiConfig(home.configDir).mouse).toBe(false);
  });
});
