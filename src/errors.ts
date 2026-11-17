/** Base class for errors the CLI reports to the user with exit code 1. */
export class AgentTasksError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}\n${details.map((d) => `  - ${d}`).join("\n")}` : message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Wrong command line usage. The CLI exits with code 2. */
export class UsageError extends AgentTasksError {
  constructor(message: string) {
    super("usage", message);
  }
}

/** The user config file exists but is invalid. */
export class ConfigError extends AgentTasksError {
  readonly file: string;

  constructor(file: string, details: string[]) {
    super("invalid_config", `Invalid config in ${file}:`, details);
    this.file = file;
  }
}

/** A task or run does not pass validation. */
export class ValidationError extends AgentTasksError {
  constructor(what: string, details: string[]) {
    super("invalid_data", `Invalid ${what}:`, details);
  }
}

/** A data file could not be parsed or does not match the schema. */
export class CorruptFileError extends AgentTasksError {
  readonly file: string;

  constructor(file: string, reason: string) {
    super("corrupt_file", `Corrupt file ${file}: ${reason}`);
    this.file = file;
  }
}

export class NotFoundError extends AgentTasksError {
  constructor(message: string) {
    super("not_found", message);
  }
}

/** A run's session no longer exists (closed, exited or gone). */
export class SessionGoneError extends AgentTasksError {
  constructor(message: string) {
    super("session_gone", message);
  }
}

/** A client could not reach the hub over SSH (or the hub has no agent-tasks). */
export class HubUnreachableError extends AgentTasksError {
  constructor(message: string) {
    super("hub_unreachable", message);
  }
}
