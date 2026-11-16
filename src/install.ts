import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type Env, expandHome, REPO_ROOT } from "./paths.ts";

// `agent-tasks install`: symlinks the CLI into a bin folder and the skills
// (the repo's, plus the user's own from `<config dir>/skills/`) into the
// agent's skills folder. It only ever replaces or removes links it owns.

export const DEFAULT_BIN_DIR = "~/.local/bin";
export const DEFAULT_SKILLS_DIR = "~/.claude/skills";

/** The CLI entry point of this checkout, which `install` links into the bin folder. */
export const CLI_BIN = join(REPO_ROOT, "bin", "agent-tasks");

export interface InstallDirs {
  binDir: string;
  skillsDir: string;
}

export function installDirs(env: Env, opts: { binDir?: string; skillsDir?: string } = {}, cwd = process.cwd()): InstallDirs {
  const abs = (p: string) => resolve(cwd, expandHome(p, env));
  return { binDir: abs(opts.binDir ?? DEFAULT_BIN_DIR), skillsDir: abs(opts.skillsDir ?? DEFAULT_SKILLS_DIR) };
}

export interface LinkSource {
  kind: "bin" | "skill";
  name: string;
  /** Absolute path the link points at. */
  source: string;
  /** `repo` or `user` (a skill from the config folder, which wins over a repo skill of the same name). */
  origin: "repo" | "user";
}

/** Skill folders (with a SKILL.md) directly inside `dir`. */
function skillFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

export function repoSkillsDir(repoRoot = REPO_ROOT): string {
  return join(repoRoot, "skills");
}

/** What `install` links: the CLI, the repo's skills, and the user's skills from the config folder. */
export function installSources(configDir: string, repoRoot = REPO_ROOT): LinkSource[] {
  const bin = repoRoot === REPO_ROOT ? CLI_BIN : join(repoRoot, "bin", "agent-tasks");
  const skills = new Map<string, LinkSource>();
  const repoSkills = repoSkillsDir(repoRoot);
  for (const name of skillFolders(repoSkills)) skills.set(name, { kind: "skill", name, source: join(repoSkills, name), origin: "repo" });
  const userSkills = join(configDir, "skills");
  for (const name of skillFolders(userSkills)) skills.set(name, { kind: "skill", name, source: join(userSkills, name), origin: "user" });
  return [{ kind: "bin", name: "agent-tasks", source: bin, origin: "repo" }, ...[...skills.values()]];
}

export type LinkState = "missing" | "linked" | "foreign_link" | "not_a_link";

export interface LinkStatus extends LinkSource {
  target: string;
  state: LinkState;
  /** Where a foreign link points. */
  points_to?: string;
}

/** The absolute path a symlink points at, or null when `path` is not a symlink. */
function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return resolve(dirname(path), readlinkSync(path));
}

/** Whether two paths are the same file, following symlinks. */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function targetOf(source: LinkSource, dirs: InstallDirs): string {
  return join(source.kind === "bin" ? dirs.binDir : dirs.skillsDir, source.name);
}

export function linkStatus(source: LinkSource, dirs: InstallDirs): LinkStatus {
  const target = targetOf(source, dirs);
  const pointsTo = linkTarget(target);
  if (pointsTo !== null) {
    return samePath(pointsTo, source.source) ? { ...source, target, state: "linked" } : { ...source, target, state: "foreign_link", points_to: pointsTo };
  }
  return { ...source, target, state: exists(target) ? "not_a_link" : "missing" };
}

export type InstallAction = "created" | "unchanged" | "replaced" | "refused" | "failed";

export interface InstallStep extends LinkStatus {
  action: InstallAction;
  /** Where a replaced non-link was moved (with --force). */
  backup?: string;
  /** Why applying the step failed. */
  error?: string;
}

/**
 * Plans (and unless `dryRun`, applies) the links. Without `force`, nothing is
 * changed when any target is a foreign file or link: every step is reported
 * and the ones in the way are `refused`. With `force`, a foreign link is
 * replaced and a real file or folder is moved to `<backupDir>/<name>-<stamp>`
 * (outside the skills folder, so an old skill copy doesn't keep loading).
 */
export function install(sources: LinkSource[], dirs: InstallDirs, opts: { force: boolean; dryRun: boolean; stamp: string; backupDir: string }): InstallStep[] {
  const steps: InstallStep[] = sources.map((s) => {
    const status = linkStatus(s, dirs);
    if (status.state === "missing") return { ...status, action: "created" };
    if (status.state === "linked") return { ...status, action: "unchanged" };
    if (!opts.force) return { ...status, action: "refused" };
    return status.state === "not_a_link" ? { ...status, action: "replaced", backup: join(opts.backupDir, `${s.kind === "bin" ? "bin-" : ""}${s.name}-${opts.stamp}`) } : { ...status, action: "replaced" };
  });
  if (opts.dryRun || steps.some((s) => s.action === "refused")) return steps;
  // Each step is applied on its own: one failing (e.g. a permission error) is
  // reported and the others still run.
  return steps.map((step) => {
    if (step.action === "unchanged") return step;
    try {
      mkdirSync(dirname(step.target), { recursive: true });
      if (step.action === "replaced") {
        if (step.backup) {
          if (exists(step.backup)) throw new Error(`backup ${step.backup} already exists`);
          mkdirSync(dirname(step.backup), { recursive: true });
          renameSync(step.target, step.backup);
        } else unlinkSync(step.target);
      }
      symlinkSync(step.source, step.target);
      return step;
    } catch (err) {
      return { ...step, action: "failed" as const, error: (err as Error).message };
    }
  });
}

export interface UninstallStep {
  name: string;
  target: string;
  action: "removed" | "kept";
  /** Why a link was kept, e.g. it points somewhere else. */
  reason?: string;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/**
 * Removes the links `install` made: the CLI link if it points at this
 * checkout, and every link in the skills folder that points into this
 * checkout's `skills/` or the config folder's `skills/` (also skills that no
 * longer exist). Anything else is left alone.
 */
export function uninstall(sources: LinkSource[], dirs: InstallDirs, opts: { dryRun: boolean; configDir: string; repoRoot?: string }): UninstallStep[] {
  const steps: UninstallStep[] = [];
  const owned = [repoSkillsDir(opts.repoRoot), join(opts.configDir, "skills")];
  const bin = sources.find((s) => s.kind === "bin")!;
  const binStatus = linkStatus(bin, dirs);
  if (binStatus.state === "linked") steps.push({ name: bin.name, target: binStatus.target, action: "removed" });
  else if (binStatus.state !== "missing") steps.push({ name: bin.name, target: binStatus.target, action: "kept", reason: binStatus.state === "foreign_link" ? `points to ${binStatus.points_to}` : "not a symlink" });

  const names = new Set(sources.filter((s) => s.kind === "skill").map((s) => s.name));
  const entries = existsSync(dirs.skillsDir) ? readdirSync(dirs.skillsDir).sort() : [];
  for (const name of entries) {
    const target = join(dirs.skillsDir, name);
    const pointsTo = linkTarget(target);
    if (pointsTo !== null && owned.some((dir) => isInside(pointsTo, dir))) steps.push({ name, target, action: "removed" });
    else if (names.has(name)) steps.push({ name, target, action: "kept", reason: pointsTo ? `points to ${pointsTo}` : "not a symlink" });
  }
  if (!opts.dryRun) for (const s of steps) if (s.action === "removed") unlinkSync(s.target);
  return steps;
}
