// Fake `herdr-app` for the herdr preset tests, sharing $FAKE_HC_DIR with the
// fake `hc`. Records every call in $FAKE_HC_DIR/app-calls.jsonl. `ls` prints
// $FAKE_HC_DIR/spaces.json (default: no spaces); `do space.rename` renames a
// space there, and fails like the real app for an id it does not know.
// `$FAKE_HC_DIR/app-down` makes every command fail (no window open).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_HC_DIR!;
mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);
appendFileSync(join(dir, "app-calls.jsonl"), `${JSON.stringify(argv)}\n`);
if (existsSync(join(dir, "app-down"))) {
  process.stderr.write("fake herdr-app: no window\n");
  process.exit(1);
}
const file = join(dir, "spaces.json");
type Space = { id: string; name: string; machine: string | null };
const spaces: Space[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).spaces : [];
const flag = (name: string) => argv[argv.indexOf(`--${name}`) + 1];

if (argv[0] === "ls") {
  process.stdout.write(`${JSON.stringify({ spaces }, null, 2)}\n`);
} else if (argv[0] === "do" && argv[1] === "space.rename") {
  const space = spaces.find((s) => s.id === flag("id"));
  if (!space) {
    process.stdout.write(`${JSON.stringify({ error: `no space "${flag("id")}"` })}\n`);
    process.exit(1);
  }
  space.name = flag("name")!;
  writeFileSync(file, JSON.stringify({ spaces }));
  process.stdout.write('{ "ok": true }\n');
} else {
  process.stderr.write(`fake herdr-app: unsupported ${argv.join(" ")}\n`);
  process.exit(2);
}
