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

// `-S <socket>` before the command picks the server; the fake has only one.
const SOCKET = "/tmp/fake-tmux/default";
let args0 = argv;
if (args0[0] === "-S") args0 = args0.slice(2);
const [cmd, ...rest] = args0;
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
  /** Window id `@N`; its only pane is `%N`. */
  id: string;
  session: string;
  name: string;
  cwd: string;
  argv: string[];
  dead: boolean;
  keys: string[];
}
const file = (id: string) => join(windows, `${id.replace(/^[@%]/, "")}.json`);
const all = (): Win[] => readdirSync(windows).map((f) => JSON.parse(readFileSync(join(windows, f), "utf8")));
const find = (): Win | null => {
  const id = String(opts["-t"]);
  return /^[@%]\d+$/.test(id) && existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf8")) : null;
};
function target(): Win {
  const win = find();
  if (!win) {
    process.stderr.write(`can't find pane: ${opts["-t"]}\n`);
    process.exit(1);
  }
  return win;
}
const format = (fmt: string, win: Win | null) =>
  fmt
    .replace("#{socket_path}", SOCKET)
    .replace("#{session_id}", "$7")
    .replace("#{window_id}", win?.id ?? "")
    .replace("#{pane_id}", win ? `%${win.id.slice(1)}` : "")
    .replace("#{pane_dead}", win ? (win.dead ? "1" : "0") : "");
function newWindow(session: string): void {
  const id = `@${readdirSync(windows).length + 1}`;
  const win: Win = { id, session, name: String(opts["-n"]), cwd: String(opts["-c"]), argv: args, dead: false, keys: [] };
  writeFileSync(file(id), JSON.stringify(win));
  if (opts["-P"]) process.stdout.write(`${format(String(opts["-F"]), win)}\n`);
}

switch (cmd) {
  case "display-message":
    // Like tmux: an unknown target prints an empty format and still exits 0.
    process.stdout.write(`${format(args[0]!, find())}\n`);
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
