import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { commands } from "../src/commands/index.ts";

const REPO = resolve(import.meta.dir, "..");
const DOCS = ["README.md", "RECIPE.md", "doc/guide.md"] as const;
const RECIPE_URL = "https://github.com/victor-falcon/agent-tasks/blob/main/RECIPE.md";

/**
 * Commands the docs describe that are being added in a parallel change
 * (`attach`, T6b). Remove an entry once its command is in the registry.
 */
const PENDING_COMMANDS = new Set(["attach"]);
/** Flags documented ahead of their parallel change (`log --follow`, T6b), as `<command> <flag>`. */
const PENDING_FLAGS = new Set(["log --follow"]);
const GLOBAL_FLAGS = ["--json", "--now", "--help"];

const read = (file: string) => readFileSync(join(REPO, file), "utf8");
const commandNames = new Set(commands.map((c) => c.name));
const presetNames = new Set(readdirSync(join(REPO, "presets")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));

/**
 * The text of every fenced code block and inline code span. ```text fences
 * hold prose (the copy-paste prompt), not commands, so they are left out.
 */
function codeOf(markdown: string): string[] {
  const fences = [...markdown.matchAll(/^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```/gm)];
  const fenced = fences.filter((m) => m[1]!.trim() !== "text").map((m) => m[2]!);
  const withoutFenced = markdown.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```/gm, "");
  const inline = [...withoutFenced.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return [...fenced, ...inline];
}

const COMMAND_RE = /(?<![\w/."-])agent-tasks ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g;

/** Code with shell comments removed and `\`-continued lines joined. */
function codeLines(markdown: string): string[] {
  return codeOf(markdown)
    .map((code) => code.replace(/\\\n\s*/g, " ").replace(/(^|\s)#.*$/gm, "$1"))
    .flatMap((code) => code.split("\n"));
}

/** The registry name for a match: the two-word one (`config check`) when it exists. */
function nameOf(first: string, second: string | undefined): string {
  return second && commandNames.has(`${first} ${second}`) ? `${first} ${second}` : first;
}

/** `agent-tasks <command>` mentions in code. */
function mentionedCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of codeLines(markdown)) {
    for (const m of line.matchAll(COMMAND_RE)) found.add(nameOf(m[1]!, m[2]));
  }
  return [...found].sort();
}

/** `<command> <flag>` for every flag written after an `agent-tasks <command>`, up to the next pipe, `;`, `&&` or `)`. */
function mentionedFlags(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of codeLines(markdown)) {
    for (const m of line.matchAll(COMMAND_RE)) {
      const rest = line.slice(m.index! + m[0].length).split(/\||;|&&|\)|(?<![\w/.-])agent-tasks /)[0]!;
      for (const flag of rest.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) found.add(`${nameOf(m[1]!, m[2])} ${flag[0]}`);
    }
  }
  return [...found].sort();
}

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
}

const anchorsOf = (markdown: string) => new Set([...markdown.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]!)));

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

  for (const file of DOCS) {
    test(`${file}: every flag it passes to an agent-tasks command exists`, () => {
      const unknown = mentionedFlags(read(file)).filter((entry) => {
        const [name, flag] = [entry.slice(0, entry.lastIndexOf(" ")), entry.slice(entry.lastIndexOf(" ") + 1)];
        const command = commands.find((c) => c.name === name);
        if (!command) return false; // reported by the command test
        return !GLOBAL_FLAGS.includes(flag) && !command.usage.includes(flag) && !PENDING_FLAGS.has(entry);
      });
      expect(unknown).toEqual([]);
    });

    test(`${file}: every relative link and anchor resolves`, () => {
      const markdown = read(file);
      const broken: string[] = [];
      for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        const [path, anchor] = target!.split("#");
        const linked = path ? join(REPO, dirname(file), path) : join(REPO, file);
        if (!existsSync(linked)) broken.push(target!);
        else if (anchor && linked.endsWith(".md") && !anchorsOf(readFileSync(linked, "utf8")).has(anchor)) broken.push(target!);
      }
      expect(broken).toEqual([]);
    });
  }

  test("RECIPE.md: every step it refers to exists", () => {
    const recipe = read("RECIPE.md");
    const steps = new Set([...recipe.matchAll(/^#{2,3} (\d+[a-z]?)\. /gm)].map((m) => m[1]!));
    const refs = [...recipe.matchAll(/\b(?:step|see|in|described in) (\d+[a-z]?)\b(?! ?(?:minutes|m\b))/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(5);
    expect(refs.filter((ref) => !steps.has(ref))).toEqual([]);
  });

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
    const md = "Run `agent-tasks config check` and `agent-tasks runner`.\n\n```sh\ncd ~/src/agent-tasks-src\nbin/agent-tasks install   # links agent-tasks into ~/.local/bin\ngit clone https://x/agent-tasks.git\nagent-tasks session close a/b\n```\n\n1. Step:\n\n   ```sh\n   agent-tasks runner status\n   ```\n\n```text\nSet up agent-tasks on this machine.\n```\n";
    expect(mentionedCommands(md)).toEqual(["config check", "runner", "runner status", "session close"]);
  });

  test("the flag scan stops at pipes and continues over backslash-newlines", () => {
    const md = "```sh\nagent-tasks add --title x \\\n  --at y\nagent-tasks log a --raw | less --chop\n```\n";
    expect(mentionedFlags(md)).toEqual(["add --at", "add --title", "log --raw"]);
  });
});
