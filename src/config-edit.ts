// Editing top-level keys of config.json in place, keeping the rest of the
// file (its order, blank lines and formatting) as it is. Used by
// `init --join` and `machines add|rm`. An edit is only written when the
// result parses back to exactly the intended object; otherwise the caller
// gets null and tells the user what to change by hand.

interface Entry {
  key: string;
  /** Where the key's string starts. */
  keyStart: number;
  valueStart: number;
  /** Just past the value (before any whitespace and the `,`). */
  valueEnd: number;
}

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function skipSpace(text: string, i: number): number {
  while (isSpace(text[i])) i++;
  return i;
}

/** End of the JSON string starting at `i` (a `"`), just past its closing quote. */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

/** End of the JSON value starting at `i`. */
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === '"') {
      j = stringEnd(text, j) - 1;
      if (j < 0) return -1;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) return trimEnd(text, j);
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === "," && depth === 0) return trimEnd(text, j);
  }
  return -1;
}

function trimEnd(text: string, end: number): number {
  while (end > 0 && isSpace(text[end - 1])) end--;
  return end;
}

/** The top-level keys of a JSON object text with where their values are, or null when it can't be read. */
function topLevelEntries(text: string): { open: number; close: number; entries: Entry[] } | null {
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return null;
  const open = i;
  i = skipSpace(text, i + 1);
  const entries: Entry[] = [];
  while (text[i] !== "}") {
    if (text[i] !== '"') return null;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return null;
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    const keyStart = i;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return null;
    const valueStart = skipSpace(text, i + 1);
    const end = valueEnd(text, valueStart);
    if (end < 0) return null;
    entries.push({ key, keyStart, valueStart, valueEnd: end });
    i = skipSpace(text, end);
    if (text[i] === ",") i = skipSpace(text, i + 1);
    else if (text[i] !== "}") return null;
  }
  return { open, close: i, entries };
}

/**
 * A value written the way config.json is: `{ "ssh": "mac" }` on one line
 * when short, one key per line otherwise.
 */
export function formatJson(value: unknown, indent: string): string {
  const inline = JSON.stringify(value, null, 1)?.replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]") ?? "null";
  if (inline.length <= 60 || value === null || typeof value !== "object" || Array.isArray(value)) return inline;
  const inner = `${indent}  `;
  const lines = Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`);
  return lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n${indent}}`;
}

/** The indentation of the line `pos` is on. */
function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * `text` (a JSON object) with top-level keys set to new values: replaced
 * where they are, or added at the top. Returns null when the file can't be
 * edited safely (not a plain JSON object, or the result would not parse back
 * to the intended object).
 */
export function setTopLevelKeys(text: string, values: Record<string, unknown>): string | null {
  let original: unknown;
  try {
    original = JSON.parse(text);
  } catch {
    return null;
  }
  if (original === null || typeof original !== "object" || Array.isArray(original)) return null;
  const parsed = topLevelEntries(text);
  if (!parsed) return null;

  let out = text;
  const firstIndent = parsed.entries[0] ? indentAt(text, parsed.entries[0].keyStart) : "  ";
  const existing = (key: string) => parsed.entries.findLast((e) => e.key === key);
  // New keys go at the top, in the order given.
  const added = Object.entries(values)
    .filter(([key]) => !existing(key))
    .map(([key, value]) => `${firstIndent}${JSON.stringify(key)}: ${formatJson(value, firstIndent)}`);
  // Replace from the end so earlier offsets stay valid.
  const replaced = Object.entries(values)
    .flatMap(([key, value]) => {
      const entry = existing(key);
      return entry ? [{ entry, value }] : [];
    })
    .sort((a, b) => b.entry.valueStart - a.entry.valueStart);
  for (const { entry, value } of replaced) {
    out = out.slice(0, entry.valueStart) + formatJson(value, indentAt(text, entry.keyStart)) + out.slice(entry.valueEnd);
  }
  if (added.length > 0) {
    const first = parsed.entries[0];
    if (first) {
      const lineStart = out.lastIndexOf("\n", first.keyStart - 1) + 1;
      const sameLine = out.slice(lineStart, first.keyStart).trim() !== "";
      out = sameLine
        ? `${out.slice(0, first.keyStart)}${added.map((l) => l.trim()).join(", ")}, ${out.slice(first.keyStart)}`
        : `${out.slice(0, lineStart)}${added.join(",\n")},\n${out.slice(lineStart)}`;
    } else {
      out = `${out.slice(0, parsed.open)}{\n${added.join(",\n")}\n}${out.slice(parsed.close + 1)}`;
    }
  }

  try {
    const expected = { ...(original as Record<string, unknown>), ...values };
    return Bun.deepEquals(JSON.parse(out), expected, true) ? out : null;
  } catch {
    return null;
  }
}
