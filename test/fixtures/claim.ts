// Child process for the concurrent-claim test: tries to claim one slot and
// prints "claimed" or "lost".
import { dataPaths } from "../../src/paths.ts";
import { claimRun } from "../../src/store.ts";

const [dataDir, id] = process.argv.slice(2) as [string, string];
const claimed = claimRun(dataPaths(dataDir), {
  task_id: "weekly-report",
  slot: "2026-11-17T09:00:00+01:00",
  trigger: "schedule",
  status: "running",
  reason: null,
  attempts: [],
  events: [{ at: "2026-11-17T09:00:01+01:00", event: "claimed", by: id }],
});
process.stdout.write(claimed ? "claimed" : "lost");
