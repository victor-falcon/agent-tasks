// Fake `ssh` for the multi-machine tests (client forwarding, remote
// execution): runs the remote command line locally with `/bin/sh -c`, in the
// environment of the host alias, so a hub and a client can live on one
// machine.
//
// $FAKE_SSH_DIR/hosts.json maps each alias to the environment of that "machine"
// (HOME, AGENT_TASKS_HOME, AGENT_TASKS_CONFIG…); the command starts in its
// HOME, with this PATH (like real non-interactive SSH, no ~/.local/bin).
// An alias missing from it fails like a host that is down (exit 255). Every
// call is recorded in $FAKE_SSH_DIR/calls.jsonl, with the stdin it received.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_SSH_DIR!;
const argv = process.argv.slice(2);

let i = 0;
const options: string[] = [];
while (i < argv.length) {
  const arg = argv[i]!;
  if (arg === "--") {
    i++;
    break;
  }
  if (!arg.startsWith("-")) break;
  options.push(arg);
  if (arg === "-o") options.push(argv[++i]!);
  i++;
}
const alias = argv[i]!;
const line = argv.slice(i + 1).join(" ");
const input = process.stdin.isTTY ? new Uint8Array() : await Bun.stdin.bytes();
const stdin = new TextDecoder().decode(input);
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ options, alias, line, stdin })}\n`);

const hostsFile = join(dir, "hosts.json");
const hosts: Record<string, Record<string, string>> = existsSync(hostsFile) ? JSON.parse(readFileSync(hostsFile, "utf8")) : {};
const host = hosts[alias];
if (!host) {
  process.stderr.write(`ssh: connect to host ${alias} port 22: Connection refused\n`);
  process.exit(255);
}

const child = Bun.spawn({
  cmd: ["/bin/sh", "-c", line],
  cwd: host.HOME,
  env: { PATH: process.env.PATH!, ...host },
  stdin: input,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
