import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

export interface SessionLaunchRequest {
  name: string;
  cwd: string;
  prompt?: string | undefined;
}

export interface SessionLaunchResult {
  name: string;
  cwd: string;
}

export class TmuxLauncher {
  readonly #ompPath: string;

  constructor(ompPath: string) {
    this.#ompPath = ompPath;
  }

  async launch(request: SessionLaunchRequest): Promise<SessionLaunchResult> {
    const normalized = normalizeLaunchRequest(request);
    try {
      accessSync(this.#ompPath, constants.X_OK);
    } catch {
      throw new Error(`OMP executable is not available: ${this.#ompPath}`);
    }

    const result = await runCommand("tmux", buildTmuxArguments(normalized, this.#ompPath));
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `tmux exited with code ${result.code}`;
      throw new Error(detail);
    }
    return { name: normalized.name, cwd: normalized.cwd };
  }
}

export function normalizeLaunchRequest(request: SessionLaunchRequest, home = homedir()): SessionLaunchRequest {
  const name = request.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error("Session name must be 1–64 letters, numbers, dots, underscores, or hyphens");
  }

  const enteredCwd = request.cwd.trim();
  if (!enteredCwd) throw new Error("Working directory is required");
  const expandedCwd = enteredCwd === "~" ? home : enteredCwd.startsWith("~/") ? resolve(home, enteredCwd.slice(2)) : enteredCwd;
  let cwd: string;
  try {
    cwd = realpathSync(resolve(expandedCwd));
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Working directory does not exist: ${enteredCwd}`);
  }

  const prompt = request.prompt?.trim();
  if (prompt && prompt.length > 3_000) throw new Error("Initial prompt must be at most 3,000 characters");
  return { name, cwd, ...(prompt ? { prompt } : {}) };
}

export function buildTmuxArguments(request: SessionLaunchRequest, ompPath: string): string[] {
  const environment = [
    "-e",
    "SLACKOFF_AUTO_ENABLE=1",
    "-e",
    `SLACKOFF_OMP_PATH=${ompPath}`,
    "-e",
    `SLACKOFF_CWD=${request.cwd}`,
  ];
  if (request.prompt) environment.push("-e", `SLACKOFF_INITIAL_PROMPT=${request.prompt}`);
  const command = request.prompt
    ? 'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD" "$SLACKOFF_INITIAL_PROMPT"'
    : 'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD"';
  return ["new-session", "-d", "-s", request.name, "-c", request.cwd, ...environment, command];
}

function runCommand(program: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stderr }));
  });
}
