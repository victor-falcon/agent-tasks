// runner.log lines taken apart for the System view's events: the runner
// writes them for people (src/runner.ts), this reads them back.

/** One line of runner.log, taken apart to be shown in columns. */
export interface LogEvent {
  /** `13:07:15`, or "" for lines written before runner.log carried the time on every line. */
  time: string;
  mark: string;
  /** The task, for run events; null for the runner's own lines. */
  task: string | null;
  /** What happened: `succeeded in 15s`, `runner started · every 5m`… */
  what: string;
  /** The agent's summary or an error, when there is one. */
  note: string;
}

/** A runner.log line as columns, or null for the lines not worth showing (the tick heartbeats). */
export function parseLogLine(line: string): LogEvent | null {
  const timed = /^(\d\d:\d\d:\d\d) {2}(.*)$/.exec(line);
  const time = timed ? timed[1]! : "";
  const rest = timed ? timed[2]! : line;
  if (rest.trim() === "" || /^tick {2}/.test(rest)) return null;
  const header = /^agent-tasks runner · (.*)$/.exec(rest);
  if (header) {
    const parts = header[1]!.split(" · ").filter((p) => !p.startsWith("data: ")).map((p) => p.replace(/^launcher: /, ""));
    return { time, mark: "●", task: null, what: ["runner started", ...parts].join(" · "), note: "" };
  }
  const final = /^● (.+?) · last tick /.exec(rest);
  if (final) {
    // `degraded (see ⚠ above)` → `degraded`: the screen's pointer means nothing here.
    const health = final[1]!.split(" (")[0]!;
    return { time, mark: "○", task: null, what: health === "stopped" ? "runner stopped" : health === "healthy" ? "runner exited" : `runner exited (${health})`, note: "" };
  }
  const event = /^(\S) (.*)$/.exec(rest);
  if (!event) return { time, mark: " ", task: null, what: rest, note: "" };
  const [, mark, body] = event as unknown as [string, string, string];
  // Run events put the run ref (or a task id) first, padded so the details
  // line up: a run ref, or a task id followed by the padding. Anything else
  // (warnings, recoveries) is the runner's own text.
  const ref = /^([\w.-]+\/\d{8}T\d{4,6}Z) +(.*)$/.exec(body) ?? /^([\w.-]+) {2,}(.*)$/.exec(body);
  if (!ref) return { time, mark, task: null, what: body, note: "" };
  const task = ref[1]!.split("/")[0]!;
  // The command hints at the end are for the terminal; here the run is a key away.
  const detail = ref[2]!.replace(/ · agent-tasks (log|attach) \S+$/, "");
  const cut = detail.indexOf(" · ");
  const what = cut === -1 ? detail : detail.slice(0, cut);
  const note = cut === -1 ? "" : detail.slice(cut + 3).replace(/^"([\s\S]*)"$/, "$1");
  return { time, mark, task, what, note };
}
