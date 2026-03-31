// REPL-safe exit utilities
// When running inside the interactive shell (REPL), we must NOT call
// process.exit() because that kills the entire process. Instead we throw a
// lightweight error that the shell loop can catch and swallow.

export class ShellExitError extends Error {
  public exitCode: number;
  constructor(message: string, exitCode: number = 0) {
    super(message);
    this.name = "ShellExitError";
    this.exitCode = exitCode;
  }
}

let _replMode = false;

export function setReplMode(on: boolean): void {
  _replMode = on;
}

export function shellExit(code: number = 0): void {
  if (_replMode) {
    throw new ShellExitError(`exit ${code}`, code);
  }
  process.exit(code);
}
