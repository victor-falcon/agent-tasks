// Fake `rex` for the rex preset tests. Records every call in
// $FAKE_REX_DIR/calls.jsonl and keeps one JSON file per block in
// $FAKE_REX_DIR/blocks/, which tests edit to simulate state changes.
// `$FAKE_REX_DIR/fail-<command>` makes that command (e.g. `fail-send`) exit 1.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_REX_DIR!;
const blocks = join(dir, "blocks");
mkdirSync(blocks, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

const sep = argv.indexOf("--");
const words = sep === -1 ? argv : argv.slice(0, sep);
const command = words.filter((w) => !w.startsWith("-"));
if (existsSync(join(dir, `fail-${command[0]}`))) {
  process.stderr.write(`fake rex: ${command[0]} failed\n`);
  process.exit(1);
}
const flag = (name: string) => {
  const i = words.indexOf(name);
  return i === -1 ? undefined : words[i + 1];
};
// Positional words, without the values of -s/-b/-c.
const positional = words.filter((w, i) => !w.startsWith("-") && !["-s", "-b", "-c"].includes(words[i - 1]!));

interface Block {
  block_id: string;
  window_id: string;
  session: string;
  name: string;
  cwd: string;
  argv: string[];
  /** program_status state, or null when nothing reported one. */
  state: string | null;
  typed: string[];
}
const file = (b: string) => join(blocks, `${b}.json`);
function block(id: string | undefined): Block {
  if (!id || !existsSync(file(id))) {
    process.stderr.write(`no block ${id}\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file(id), "utf8"));
}
const save = (b: Block) => writeFileSync(file(b.block_id), JSON.stringify(b));
const session = flag("-s");
if (!session) {
  process.stderr.write("fake rex: -s is required\n");
  process.exit(2);
}

switch (positional.slice(0, 2).join(" ")) {
  case "window new": {
    const n = readdirSync(blocks).length + 1;
    const b: Block = { block_id: `b${n}`, window_id: `w${n}`, session, name: positional[2]!, cwd: flag("-c")!, argv: argv.slice(sep + 1), state: null, typed: [] };
    save(b);
    process.stdout.write(`${JSON.stringify({ window_id: b.window_id, block_ids: [b.block_id] })}\n`);
    break;
  }
  case "window close": {
    const ids = readdirSync(blocks).map((f) => f.slice(0, -5)).filter((id) => block(id).window_id === positional[2]);
    if (ids.length === 0) process.exit(1);
    for (const id of ids) rmSync(file(id));
    break;
  }
  case "block inspect": {
    const b = block(positional[2]);
    process.stdout.write(JSON.stringify({ block: { block_id: b.block_id, window_id: b.window_id } }));
    break;
  }
  case "block call": {
    const b = block(flag("-b"));
    process.stdout.write(JSON.stringify({ records: b.state ? [{ state: b.state, updated_at: "2026-11-17T08:00:00Z" }] : [] }));
    break;
  }
  default:
    switch (positional[0]) {
      case "send": {
        const b = block(flag("-b"));
        b.typed.push(positional[1]!);
        save(b);
        break;
      }
      case "send-key": {
        const b = block(flag("-b"));
        b.typed.push(`<${positional[1]}>`);
        save(b);
        break;
      }
      case "capture":
        process.stdout.write(`screen of ${block(flag("-b")).block_id}\n`);
        break;
      case "focus":
        break;
      default:
        process.stderr.write(`fake rex: unknown command ${argv.join(" ")}\n`);
        process.exit(2);
    }
}
