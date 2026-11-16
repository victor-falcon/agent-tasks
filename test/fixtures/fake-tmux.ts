// Fake `tmux` for the tmux preset tests. Records every call in
// $FAKE_TMUX_DIR/calls.jsonl and keeps one JSON file per window in
// $FAKE_TMUX_DIR/windows/, which tests edit to simulate state changes.
// `$FAKE_TMUX_DIR/fail-<command>` makes that command exit 1.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_TMUX_DIR!;
const windows = join(dir, "windows");
mkdirSync(windows, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

const [cmd, ...rest] = argv;
if (existsSync(join(dir, `fail-${cmd}`))) {
  process.stderr.write(`fake tmux: ${cmd} failed\n`);
  process.exit(1);
}

// Flags that take a value; everything after `--` is the window's command.
const VALUE_FLAGS = ["-t", "-F", "-s", "-n", "-c", "-S"];
const opts: Record<string, string | true> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a === "--") {
    args.push(...rest.slice(i + 1));
    break;
  }
  if (VALUE_FLAGS.includes(a)) opts[a] = rest[++i]!;
  else if (/^-[a-zA-Z]+$/.test(a)) opts[a] = true;
  else args.push(a);
}

interface Win {
  id: string;
  session: string;
  name: string;
  cwd: string;
  argv: string[];
  dead: boolean;
  keys: string[];
}
const file = (id: string) => join(windows, `${id.replace(/^@/, "")}.json`);
const all = (): Win[] => readdirSync(windows).map((f) => JSON.parse(readFileSync(join(windows, f), "utf8")));
function target(): Win {
  const id = String(opts["-t"]);
  if (!existsSync(file(id))) {
    process.stderr.write(`can't find window: ${id}\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file(id), "utf8"));
}
function newWindow(session: string): void {
  const id = `@${readdirSync(windows).length + 1}`;
  const win: Win = { id, session, name: String(opts["-n"]), cwd: String(opts["-c"]), argv: args, dead: false, keys: [] };
  writeFileSync(file(id), JSON.stringify(win));
  if (opts["-P"]) process.stdout.write(`${String(opts["-F"]).replace("#{window_id}", id)}\n`);
}

switch (cmd) {
  case "display":
  case "display-message":
    // Only what the preset asks: the current session's name.
    process.stdout.write(`${process.env.TMUX ? "main" : ""}\n`);
    break;
  case "has-session":
    if (!all().some((w) => `=${w.session}` === opts["-t"])) process.exit(1);
    break;
  case "new-session":
    newWindow(String(opts["-s"]));
    break;
  case "new-window":
    newWindow(String(opts["-t"]).replace(/^=/, "").replace(/:$/, ""));
    break;
  case "send-keys": {
    const win = target();
    win.keys.push(...args.map((k) => (opts["-l"] ? k : `<${k}>`)));
    writeFileSync(file(win.id), JSON.stringify(win));
    break;
  }
  case "list-panes":
    process.stdout.write(`${target().dead ? 1 : 0}\n`);
    break;
  case "capture-pane":
    process.stdout.write(`screen of ${target().id}\n`);
    break;
  case "kill-window":
    rmSync(file(target().id));
    break;
  case "select-window":
  case "switch-client":
  case "attach-session":
    target();
    break;
  default:
    process.stderr.write(`fake tmux: unknown command ${cmd}\n`);
    process.exit(2);
}
