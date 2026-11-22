import { type CliRenderer, type OptimizedBuffer, RGBA, SyntaxStyle, TextAttributes } from "@opentui/core";
import type { Color } from "../output/style.ts";
import type { Mark } from "../output/symbols.ts";

// Colors come from the terminal's own palette only: the 16 ANSI colors by
// index (RGBA.fromIndex, sent as `38;5;N`) and the default foreground and
// background (`39`/`49`), so the dashboard follows the user's theme, light or
// dark. No RGB values: OpenTUI paints an element without a color in
// truecolor white, so every element takes `fg`/`bg` from here, and
// `paletteGuard` turns whatever is left (empty cells, built-in parts such as
// the scrollbar) into the defaults before a frame is sent. With NO_COLOR every
// color is the default one; bold, dim and inverse stay.

export interface Theme {
  /** The terminal's default foreground and background. */
  fg: RGBA;
  bg: RGBA;
  red: RGBA;
  green: RGBA;
  yellow: RGBA;
  blue: RGBA;
  magenta: RGBA;
  cyan: RGBA;
  /** Lines and borders: the default color, dimmed where it is drawn. */
  border: RGBA;
  /** Markdown and code: the same palette. */
  syntax: SyntaxStyle;
  colored: boolean;
}

const ANSI = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 } as const;

export function colorEnabled(env: Record<string, string | undefined>): boolean {
  return env.NO_COLOR === undefined || env.NO_COLOR === "";
}

export function createTheme(env: Record<string, string | undefined>, renderer: CliRenderer): Theme {
  const colored = colorEnabled(env);
  const fg = RGBA.defaultForeground();
  const bg = RGBA.defaultBackground();
  const pick = (name: keyof typeof ANSI) => (colored ? RGBA.fromIndex(ANSI[name]) : fg);
  const theme = {
    fg,
    bg,
    red: pick("red"),
    green: pick("green"),
    yellow: pick("yellow"),
    blue: pick("blue"),
    magenta: pick("magenta"),
    cyan: pick("cyan"),
    border: fg,
    colored,
  };
  return { ...theme, syntax: syntaxStyle(theme, renderer) };
}

function syntaxStyle(t: Omit<Theme, "syntax">, renderer: CliRenderer): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: { fg: t.fg },
      "markup.heading": { fg: t.cyan, bold: true },
      "markup.strong": { fg: t.fg, bold: true },
      "markup.italic": { fg: t.fg, italic: true },
      "markup.strikethrough": { fg: t.fg, strikethrough: true, dim: true },
      "markup.list": { fg: t.yellow },
      "markup.quote": { fg: t.fg, dim: true },
      "markup.raw": { fg: t.green },
      "markup.raw.block": { fg: t.fg },
      "markup.link": { fg: t.blue, underline: true },
      "markup.link.label": { fg: t.blue },
      "markup.link.url": { fg: t.blue, underline: true },
      conceal: { fg: t.fg, dim: true },
      comment: { fg: t.fg, dim: true },
      keyword: { fg: t.magenta },
      string: { fg: t.green },
      number: { fg: t.yellow },
      function: { fg: t.blue },
      type: { fg: t.cyan },
    },
    // The style lives in the renderer's native context and goes with it.
    renderer.nativeScene,
  );
}

/** A color of src/output/style.ts (`dim` and `bold` are attributes) as a foreground and attributes. */
export function paint(theme: Theme, color: Color | undefined): { fg: RGBA; attributes: number } {
  switch (color) {
    case undefined:
      return { fg: theme.fg, attributes: 0 };
    case "dim":
      return { fg: theme.fg, attributes: TextAttributes.DIM };
    case "bold":
      return { fg: theme.fg, attributes: TextAttributes.BOLD };
    case "inverse":
      return { fg: theme.fg, attributes: TextAttributes.INVERSE };
    default:
      return { fg: theme[color], attributes: 0 };
  }
}

export function markStyle(theme: Theme, mark: Mark): { fg: RGBA; attributes: number } {
  return paint(theme, mark.color);
}

export const BOLD = TextAttributes.BOLD;
export const DIM = TextAttributes.DIM;
export const INVERSE = TextAttributes.INVERSE;

// A color's intent is the high byte of its second channel (see RGBA.intent).
const intentOf = (plane: Uint16Array, i: number) => plane[i + 1]! >> 8;
const DEFAULT_FG = RGBA.defaultForeground().buffer;
const DEFAULT_BG = RGBA.defaultBackground().buffer;
const PALETTE_INTENTS = new Set([intentOf(DEFAULT_FG, 0), intentOf(RGBA.fromIndex(1).buffer, 0)]);

/**
 * A post-process step of every frame: any cell still colored with an RGB
 * value (OpenTUI's own defaults: cleared cells, scrollbars) gets the
 * terminal's default color instead, so nothing but the palette is ever sent.
 */
export function paletteGuard(buffer: OptimizedBuffer): void {
  const { fg, bg } = buffer.buffers;
  for (let i = 0; i < fg.length; i += 4) {
    if (!PALETTE_INTENTS.has(intentOf(fg, i))) fg.set(DEFAULT_FG, i);
    if (!PALETTE_INTENTS.has(intentOf(bg, i))) bg.set(DEFAULT_BG, i);
  }
}
