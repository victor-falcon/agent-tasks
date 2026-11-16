import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commands } from "../src/commands/index.ts";

const REPO = resolve(import.meta.dir, "..");
const DOCS = ["README.md", "RECIPE.md"] as const;
const RECIPE_URL = "https://github.com/victor-falcon/agent-tasks/blob/main/RECIPE.md";

/**
 * Commands the docs describe that are being added in a parallel change
 * (`attach`, T6b). Remove an entry once its command is in the registry.
 */
const PENDING_COMMANDS = new Set(["attach"]);

const read = (file: string) => readFileSync(join(REPO, file), "utf8");
const commandNames = new Set(commands.map((c) => c.name));
const presetNames = new Set(readdirSync(join(REPO, "presets")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));

/** The text of every fenced code block and inline code span. */
function codeOf(markdown: string): string[] {
  const fenced = [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
  const withoutFenced = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  const inline = [...withoutFenced.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return [...fenced, ...inline];
}

/** `agent-tasks <command>` mentions in code, resolved to a registry name when a two-word one exists. */
function mentionedCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const code of codeOf(markdown)) {
    const withoutComments = code.replace(/(^|\s)#.*$/gm, "$1");
    for (const m of withoutComments.matchAll(/(?<![\w/.-])agent-tasks ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const [, first, second] = m;
      found.add(second && commandNames.has(`${first} ${second}`) ? `${first} ${second}` : first!);
    }
  }
  return [...found].sort();
}

/** Preset names the docs use: `"preset": "x"` and the README's presets table. */
function mentionedPresets(markdown: string): string[] {
  const found = new Set<string>();
  for (const m of markdown.matchAll(/"preset":\s*"([^"]+)"/g)) found.add(m[1]!);
  const table = /^## Presets\n([\s\S]*?)(?=^## )/m.exec(markdown)?.[1] ?? "";
  for (const m of table.matchAll(/^\| `([^`]+)` \|/gm)) found.add(m[1]!);
  return [...found].sort();
}

describe("docs", () => {
  for (const file of DOCS) {
    test(`${file}: every agent-tasks command it mentions exists`, () => {
      const mentioned = mentionedCommands(read(file));
      expect(mentioned.length).toBeGreaterThan(5);
      const unknown = mentioned.filter((name) => !commandNames.has(name) && !PENDING_COMMANDS.has(name));
      expect(unknown).toEqual([]);
    });

    test(`${file}: every preset it names exists in presets/`, () => {
      const unknown = mentionedPresets(read(file)).filter((name) => !presetNames.has(name));
      expect(unknown).toEqual([]);
    });
  }

  test("README.md: the copy-paste prompt points at RECIPE.md", () => {
    const readme = read("README.md");
    const section = /^## Quick setup with your agent\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1];
    expect(section).toBeDefined();
    const prompt = /^```[^\n]*\n([\s\S]*?)^```/m.exec(section!)?.[1];
    expect(prompt).toBeDefined();
    expect(prompt).toContain(RECIPE_URL);
  });

  test("README.md: the presets table lists every preset in presets/", () => {
    expect(mentionedPresets(read("README.md"))).toEqual(expect.arrayContaining([...presetNames]));
  });

  test("the command scan finds two-word commands and ignores paths", () => {
    const md = "Run `agent-tasks config check` and `agent-tasks runner`.\n\n```sh\ncd ~/src/agent-tasks-src\nbin/agent-tasks install   # links agent-tasks into ~/.local/bin\ngit clone https://x/agent-tasks.git\nagent-tasks session close a/b\n```\n";
    expect(mentionedCommands(md)).toEqual(["config check", "runner", "session close"]);
  });
});
