import { join, resolve } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { UsageError } from "../errors.ts";
import { DEFAULT_BIN_DIR, DEFAULT_SKILLS_DIR, install, type InstallStep, installDirs, installSources, uninstall, type UninstallStep } from "../install.ts";
import { expandHome, resolveConfigLocation, tildify } from "../paths.ts";
import type { Command } from "./types.ts";

const STEP_TEXT: Record<InstallStep["action"], [done: string, planned: string]> = {
  created: ["linked", "would link"],
  unchanged: ["already linked", "already linked"],
  replaced: ["replaced", "would replace"],
  refused: ["refused", "refused"],
  failed: ["failed", "failed"],
};

/** `20261116T150000Z`, for backup names. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

const installCommand: Command = {
  name: "install",
  summary: "Link the agent-tasks CLI and the skills into your bin and skills folders",
  usage: `Usage: agent-tasks install [--bin-dir <dir>] [--skills-dir <dir>] [--force] [--dry-run]
       agent-tasks install --uninstall [--bin-dir <dir>] [--skills-dir <dir>] [--dry-run]

Creates symlinks to this checkout:
  <bin-dir>/agent-tasks   → bin/agent-tasks
  <skills-dir>/<skill>    → skills/<skill> (run-agent-task, schedule-agent-task)
  <skills-dir>/<skill>    → <config dir>/skills/<skill>, your own skills
                            (one with the same name as a repo skill replaces it)

Running it again changes nothing. When a target already exists and is not a
link to this checkout (a real file or folder, or a link that points
elsewhere), nothing is changed and the command fails, unless --force: then a
link is replaced and a real file or folder is moved to
<config dir>/backups/<name>-<time>.

--uninstall removes only the links that point into this checkout or into
the config folder's skills/; anything else is left alone.

Options:
  --bin-dir <dir>     Where to link the CLI (default ${DEFAULT_BIN_DIR})
  --skills-dir <dir>  Where to link the skills (default ${DEFAULT_SKILLS_DIR})
  --force             Replace what is in the way (see above)
  --dry-run           Print what would change, change nothing
  --uninstall         Remove the links instead`,
  run(ctx, args) {
    const { values } = parseCommandArgs(
      args,
      {
        "bin-dir": { type: "string" },
        "skills-dir": { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        uninstall: { type: "boolean" },
      },
      { maxPositionals: 0 },
    );
    const dryRun = values["dry-run"] === true;
    const dirs = installDirs(ctx.env, { binDir: values["bin-dir"], skillsDir: values["skills-dir"] }, ctx.cwd);
    const { configDir } = resolveConfigLocation(ctx.env);
    const sources = installSources(configDir);
    const show = (p: string) => tildify(p, ctx.env);

    if (values.uninstall) {
      if (values.force) throw new UsageError("--force does not apply to --uninstall");
      const steps = uninstall(sources, dirs, { dryRun, configDir });
      output(ctx, { dry_run: dryRun, bin_dir: dirs.binDir, skills_dir: dirs.skillsDir, steps }, () => renderUninstall(steps, dryRun, show));
      return 0;
    }

    const steps = install(sources, dirs, { force: values.force === true, dryRun, stamp: stamp(ctx.now), backupDir: join(configDir, "backups") });
    const ok = steps.every((s) => s.action !== "refused" && s.action !== "failed");
    const onPath = (ctx.env.PATH ?? "").split(":").some((dir) => dir !== "" && resolve(expandHome(dir, ctx.env)) === dirs.binDir);
    output(ctx, { ok, dry_run: dryRun, bin_dir: dirs.binDir, skills_dir: dirs.skillsDir, bin_dir_on_path: onPath, steps }, () => renderInstall(steps, { dryRun, onPath, binDir: dirs.binDir, show }));
    return ok ? 0 : 1;
  },
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function renderInstall(steps: InstallStep[], o: { dryRun: boolean; onPath: boolean; binDir: string; show: (p: string) => string }): string {
  const { show } = o;
  const lines = steps.map((s) => {
    const [done, planned] = STEP_TEXT[s.action];
    const bad = s.action === "refused" || s.action === "failed";
    let line = `${bad ? "✕" : "✓"} ${show(s.target)} → ${show(s.source)}: ${o.dryRun ? planned : done}`;
    if (s.action === "refused" || s.action === "replaced") {
      line += s.state === "not_a_link" ? " (a file or folder that is not a symlink" : ` (a symlink to ${show(s.points_to!)}`;
      line += s.backup ? `, ${o.dryRun ? "would move it" : "moved"} to ${show(s.backup)})` : ")";
    }
    if (s.error) line += `: ${s.error}`;
    return line;
  });
  const refused = steps.filter((s) => s.action === "refused").length;
  const failed = steps.filter((s) => s.action === "failed").length;
  if (refused > 0) lines.push("", `Nothing was changed: ${refused} ${plural(refused, "target is", "targets are")} in the way. Move ${plural(refused, "it", "them")} or run again with --force.`);
  else if (failed > 0) lines.push("", `${failed} ${plural(failed, "link", "links")} could not be created; the others were.`);
  else {
    if (!o.onPath) lines.push("", `${show(o.binDir)} is not on your PATH; add it to use agent-tasks from anywhere.`);
    if (!o.dryRun) lines.push("", "Next: agent-tasks init (creates your config), then agent-tasks doctor.");
  }
  return lines.join("\n");
}

function renderUninstall(steps: UninstallStep[], dryRun: boolean, show: (p: string) => string): string {
  if (steps.length === 0) return "Nothing to remove: no agent-tasks links found.";
  return steps
    .map((s) => (s.action === "removed" ? `✓ ${show(s.target)}: ${dryRun ? "would remove" : "removed"}` : `! ${show(s.target)}: kept (${s.reason}, not installed by agent-tasks)`))
    .join("\n");
}

export default installCommand;
