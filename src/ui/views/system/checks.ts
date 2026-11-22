import { type Accessor, createSignal } from "solid-js";
import type { App } from "../../context.ts";
import { type CheckResult, checksSummary, parseChecksOutput } from "./model.ts";

// The results of `doctor --json` and `machines check --json`, kept per
// dashboard rather than per mount: the System tab is mounted only while it
// is shown, but its badge reads them from any tab, and they are cached until
// re-run (they go over SSH, so they run in the background, never on a
// reload).

export interface BackgroundCheck {
  result: Accessor<CheckResult | null>;
  /** Why the last run could not be read (the previous result stays), or null. */
  error: Accessor<string | null>;
  running: Accessor<boolean>;
  /** Runs it in the background (spinner in the footer, a toast at the end); does nothing while it already runs. */
  run(): void;
}

export interface SystemChecks {
  doctor: BackgroundCheck;
  machines: BackgroundCheck;
}

function backgroundCheck(app: App, args: string[], doing: string, label: string): BackgroundCheck {
  const [result, setResult] = createSignal<CheckResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);
  return {
    result,
    error,
    running,
    run() {
      if (running()) return;
      setRunning(true);
      void app.actions
        .background(args, doing)
        .then(({ output }) => {
          // A failing check exits with 1 and still prints its JSON: read the output, not the code.
          const parsed = parseChecksOutput(output);
          if ("error" in parsed) {
            setError(parsed.error);
            app.actions.report(1, parsed.error, doing);
            return;
          }
          setResult({ checks: parsed.checks, at: app.store.now() });
          setError(null);
          app.ui.toast(`${label}: ${parsed.checks.length === 0 ? "nothing to check" : checksSummary(parsed.checks)}`);
        })
        .finally(() => setRunning(false));
    },
  };
}

const kept = new WeakMap<App, SystemChecks>();

/** The System tab's background checks for this dashboard (created on first use). */
export function systemChecks(app: App): SystemChecks {
  let checks = kept.get(app);
  if (!checks) {
    checks = {
      doctor: backgroundCheck(app, ["doctor", "--json"], "running doctor", "doctor"),
      machines: backgroundCheck(app, ["machines", "check", "--json"], "checking machines", "machines"),
    };
    kept.set(app, checks);
  }
  return checks;
}
