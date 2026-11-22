import { tildify } from "../../../paths.ts";
import { archivedTaskPath } from "../../../store.ts";
import type { App } from "../../context.ts";
import type { TaskItem } from "./model.ts";

/**
 * The actions on one task (TASK_TARGET_ACTIONS), the same in the Tasks tab
 * and in the Task detail. Archived tasks are not scheduled any more: they
 * can be read, copied and opened, not run, paused or archived again.
 */
export function taskHandlers(app: App, item: () => TaskItem | null) {
  const { actions, store } = app;
  /** How to bring an archived task back (as `agent-tasks rm` prints it). */
  const restore = (id: string) => {
    const ctx = store.ctx();
    return ctx ? `mv ${tildify(archivedTaskPath(ctx.paths, id), ctx.env)} ${tildify(ctx.paths.tasksDir, ctx.env)}/ && agent-tasks resume ${id}` : `agent-tasks resume ${id}`;
  };
  const live = (what: string, run: (item: TaskItem) => void) => () => {
    const it = item();
    if (!it) return;
    if (it.archived) return actions.error(`${it.task.id} is archived: it can't be ${what}. To restore it: ${restore(it.task.id)}`);
    run(it);
  };
  return {
    run_now: live("run", (it) => actions.runNow({ kind: "task", taskId: it.task.id })),
    toggle_pause: live("paused or resumed", (it) => void actions.togglePause({ kind: "task", taskId: it.task.id })),
    archive: live("archived again", (it) => actions.archive(it.task.id, it.active !== null)),
    open_folder: () => {
      const it = item();
      if (it) void actions.openFolder(it.task);
    },
    copy: () => {
      const it = item();
      if (it) actions.copy(it.task.id, "task id");
    },
  };
}
