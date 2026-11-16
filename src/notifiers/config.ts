import { Checker, checkUnknownKeys, isObject } from "../schema.ts";
import { variablesIn } from "../template.ts";
import { NOTIFY_EVENTS, type NotifierConfig } from "./types.ts";

/** Variables a `command` notifier's `run` can use (each also as `<name>_quoted`). */
export const NOTIFICATION_VARS: readonly string[] = ["event", "task_id", "title", "run_ref", "message", "count"];

// The `notifiers` section of config.json (doc/roadmap/user-config.md).

/** Used when the config has no `notifiers`. */
export const DEFAULT_NOTIFIERS: readonly NotifierConfig[] = [{ type: "system", events: ["failed", "timed_out", "blocked"] }];

function checkNotifier(c: Checker, value: unknown): void {
  if (!isObject(value)) {
    c.fail('must be an object such as { "type": "system", "events": ["failed"] }');
    return;
  }
  if (value.type !== "system" && value.type !== "command") {
    c.at("type").fail('must be "system" or "command"');
    return;
  }
  checkUnknownKeys(c, value, value.type === "system" ? ["type", "events"] : ["type", "events", "run"]);
  const events = value.events;
  if (!Array.isArray(events) || events.length === 0 || !events.every((e) => (NOTIFY_EVENTS as readonly unknown[]).includes(e))) {
    c.at("events").fail(`must be a non-empty array of: ${NOTIFY_EVENTS.join(", ")}`);
  }
  if (value.type === "command") {
    const run = value.run;
    const ok = (typeof run === "string" && run.trim() !== "") || (Array.isArray(run) && run.length > 0 && run.every((a) => typeof a === "string"));
    if (!ok) c.at("run").fail('must be an argv array such as ["notify", "{{title}}", "{{message}}"] or a shell string');
    else {
      const used = (typeof run === "string" ? [run] : (run as string[])).flatMap(variablesIn);
      const unknown = used.filter((v) => !NOTIFICATION_VARS.includes(v.replace(/_quoted$/, "")));
      if (unknown.length > 0) c.at("run").fail(`unknown variable${unknown.length > 1 ? "s" : ""} ${unknown.map((v) => `{{${v}}}`).join(", ")} (known: ${NOTIFICATION_VARS.join(", ")})`);
    }
  }
}

/** Problems with the `notifiers` section, prefixed with their path. */
export function notifierErrors(value: unknown): string[] {
  const c = new Checker("notifiers");
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    c.fail("must be an array");
    return c.errors;
  }
  value.forEach((n, i) => checkNotifier(new Checker(`notifiers[${i}]`, c.errors), n));
  return c.errors;
}

/** The notifiers of a (validated) config: the default when unset. */
export function notifiersOf(config: { notifiers?: unknown }): readonly NotifierConfig[] {
  return config.notifiers === undefined ? DEFAULT_NOTIFIERS : (config.notifiers as NotifierConfig[]);
}
