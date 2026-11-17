import type { Writer } from "../context.ts";
import type { Env } from "../paths.ts";

// Colors: only when the stream is a terminal and NO_COLOR is unset (https://no-color.org).

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  inverse: [7, 27],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

export type Color = keyof typeof CODES;

export interface Style {
  readonly enabled: boolean;
  paint(color: Color | undefined, text: string): string;
}

/** True when the writer is a terminal (`process.stdout.isTTY`); test writers can set `isTTY` too. */
export function isTerminal(writer: Writer): boolean {
  return writer.isTTY === true;
}

export function colorEnabled(writer: Writer, env: Env): boolean {
  return isTerminal(writer) && (env.NO_COLOR === undefined || env.NO_COLOR === "");
}

export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    paint(color, text) {
      if (!enabled || color === undefined || text === "") return text;
      const [open, close] = CODES[color];
      return `\u001b[${open}m${text}\u001b[${close}m`;
    },
  };
}

/** Style for a command's stdout. */
export function stdoutStyle(ctx: { stdout: Writer; env: Env }): Style {
  return createStyle(colorEnabled(ctx.stdout, ctx.env));
}

/** Style for a command's stderr (warnings, the runner banner). */
export function stderrStyle(ctx: { stderr: Writer; env: Env }): Style {
  return createStyle(colorEnabled(ctx.stderr, ctx.env));
}
