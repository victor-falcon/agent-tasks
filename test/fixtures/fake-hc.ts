// Fake `hc` for the herdr preset tests. Records every call in
// $FAKE_HC_DIR/calls.jsonl and keeps one JSON file per terminal in
// $FAKE_HC_DIR/terminals/, which tests edit to simulate state changes.
// `$FAKE_HC_DIR/fail-<subcommand>` makes that subcommand exit 1.
// `$FAKE_HC_DIR/screen-<t>` is what `hc read` prints for terminal t, and
// `$FAKE_HC_DIR/attach-exit` the exit code of `hc attach` (default 0).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_HC_DIR!;
const terminals = join(dir, "terminals");
mkdirSync(terminals, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

const [sub, ...rest] = argv;
if (existsSync(join(dir, `fail-${sub}`))) {
  process.stderr.write(`fake hc: ${sub} failed\n`);
  process.exit(1);
}
const file = (t: string) => join(terminals, `${t}.json`);
const positional = rest.filter((a) => !a.startsWith("--"));

switch (sub) {
  case "run": {
    const sep = rest.indexOf("--");
    const flags = sep === -1 ? rest : rest.slice(0, sep);
    const labels: Record<string, string> = {};
    flags.forEach((f, i) => {
      if (f === "--label") {
        const [k, ...v] = flags[i + 1]!.split("=");
        labels[k!] = v.join("=");
      }
    });
    const address = `t${readdirSync(terminals).length + 2}`;
    const info = { address, state: "live", status: null, exit_code: null, labels, parent: null, argv: sep === -1 ? [] : rest.slice(sep + 1) };
    writeFileSync(file(address), JSON.stringify(info));
    process.stdout.write(`${JSON.stringify(info)}\n`);
    break;
  }
  case "get": {
    const t = positional[0]!;
    if (t === process.env.HC_TERMINAL_ID) {
      process.stdout.write(JSON.stringify({ address: t, state: "live", status: null, labels: { "herdr.space": "sp-test" } }));
      break;
    }
    if (!existsSync(file(t))) {
      process.stderr.write(`no terminal ${t}\n`);
      process.exit(1);
    }
    process.stdout.write(readFileSync(file(t), "utf8"));
    break;
  }
  case "send":
    break;
  case "kill":
    rmSync(file(positional[0]!), { force: true });
    break;
  case "read": {
    if (!existsSync(file(positional.at(-1)!))) {
      process.stderr.write(`no terminal ${positional.at(-1)}\n`);
      process.exit(1);
    }
    const screen = join(dir, `screen-${positional.at(-1)}`);
    process.stdout.write(existsSync(screen) ? readFileSync(screen, "utf8") : `screen of ${positional.at(-1)}\n`);
    break;
  }
  case "attach": {
    process.stdout.write(`attached to ${positional[0]}\n`);
    const exit = join(dir, "attach-exit");
    process.exit(existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : 0);
    break;
  }
  default:
    process.stderr.write(`fake hc: unknown subcommand ${sub}\n`);
    process.exit(2);
}
