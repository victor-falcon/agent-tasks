import { UsageError } from "./errors.ts";
import { type Run, TASK_ID_RE } from "./schema.ts";

// Slot ids name the run files: `runs/<task-id>/<slot-id>.json`. They are pure
// string helpers, with no file access, so the schedule engine can use them.

// ---------------------------------------------------------------------------

const SLOT_ID_RE = /^(manual-)?(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** File-safe slot id in UTC: `20261117T080000Z`. Sub-second precision is dropped. */
export function slotId(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** Slot id of a manual run: `manual-20261117T080000Z`. */
export function manualSlotId(date: Date): string {
  return `manual-${slotId(date)}`;
}

export function isSlotId(id: string): boolean {
  return SLOT_ID_RE.test(id);
}

export function isManualSlotId(id: string): boolean {
  return id.startsWith("manual-") && isSlotId(id);
}

/** The instant a slot id stands for. */
export function slotIdToDate(id: string): Date {
  const m = SLOT_ID_RE.exec(id);
  if (!m) throw new UsageError(`invalid slot "${id}" (expected e.g. 20261117T080000Z or manual-20261117T080000Z)`);
  const [, , y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

/** `<task-id>/<slot-id>`, the handle subagents and commands use for one occurrence. */
export function runRef(taskId: string, slot: string): string {
  return `${taskId}/${slot}`;
}

export function parseRunRef(ref: string): { taskId: string; slot: string } {
  const parts = ref.split("/");
  if (parts.length !== 2 || !TASK_ID_RE.test(parts[0]!) || !isSlotId(parts[1]!)) {
    throw new UsageError(`invalid run ref "${ref}" (expected <task-id>/<slot>, e.g. weekly-report/20261117T080000Z)`);
  }
  return { taskId: parts[0]!, slot: parts[1]! };
}

/** The file slot id of a run: scheduled runs use their slot, manual runs get the `manual-` prefix. */
export function runSlotId(run: Pick<Run, "slot" | "trigger">): string {
  const at = new Date(run.slot);
  return run.trigger === "manual" ? manualSlotId(at) : slotId(at);
}
