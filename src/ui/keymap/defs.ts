// The shape in which a view declares actions of its own (views/<name>/keys.ts):
// name → description and default keys. Plain data with no imports, so the
// old dashboard's tui.toml loader can know these names without loading the UI.

export interface ActionDef {
  desc: string;
  keys: readonly string[];
}

export type ActionDefs = Record<string, ActionDef>;
