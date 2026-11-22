// How the dashboard acts: through this CLI's own commands (retry, run, pause,
// attach…), run as a child process so their checks, hub forwarding and
// output stay the CLI's.

/** Runs an agent-tasks command. `interactive`: hand the terminal over and wait for it. */
export type CommandRunner = (args: string[], opts: { interactive: boolean }) => Promise<{ code: number; output: string }>;

/** This same CLI: `bun <path to bin/agent-tasks>` (no `--now`: actions happen now). */
export function selfCommand(env: Record<string, string | undefined>): CommandRunner {
  const base = [process.execPath, process.argv[1]!];
  return async (args, { interactive }) => {
    const proc = Bun.spawn([...base, ...args], {
      env: { ...process.env, ...env },
      stdin: interactive ? "inherit" : "ignore",
      stdout: interactive ? "inherit" : "pipe",
      stderr: interactive ? "inherit" : "pipe",
    });
    if (interactive) return { code: await proc.exited, output: "" };
    const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    return { code, output: code === 0 ? out || err : err || out };
  };
}
