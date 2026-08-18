import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export interface OmpTmuxSession {
  name: string;
  paneId: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (program: string, args: string[]) => Promise<CommandResult>;
export interface PendingTmuxAttachment {
  promise: Promise<void>;
  cancel(): void;
}

interface TmuxAttachmentWaiter {
  name: string;
  sessionId?: string;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Couples a tmux launch/attach request to the OMP registration that creates its Slack card.
 * A successful `tmux new-session` is not sufficient: the child can exit before loading Slackoff.
 */
export class TmuxAttachmentTracker {
  readonly #waiters: TmuxAttachmentWaiter[] = [];
  readonly #timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.#timeoutMs = timeoutMs;
  }

  begin(name: string): PendingTmuxAttachment {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: TmuxAttachmentWaiter = {
      name,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.#remove(waiter);
        reject(new Error(`OMP session "${name}" did not connect to Slackoff`));
      }, this.#timeoutMs),
    };
    waiter.timer.unref();
    this.#waiters.push(waiter);
    return {
      promise,
      cancel: () => {
        if (!this.#remove(waiter)) return;
        resolve();
      },
    };
  }

  claim(sessionId: string, tmuxSessionName?: string): string | undefined {
    const waiter = this.#waiters.find(
      (candidate) => candidate.sessionId === undefined && (!tmuxSessionName || candidate.name === tmuxSessionName),
    );
    if (!waiter) return undefined;
    waiter.sessionId = sessionId;
    return waiter.name;
  }

  complete(sessionId: string): void {
    const waiter = this.#waiters.find((candidate) => candidate.sessionId === sessionId);
    if (!waiter || !this.#remove(waiter)) return;
    waiter.resolve();
  }

  #remove(waiter: TmuxAttachmentWaiter): boolean {
    const index = this.#waiters.indexOf(waiter);
    if (index < 0) return false;
    this.#waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    return true;
  }
}

export class TmuxLauncher {
  readonly #ompPath: string;
  readonly #extensionPath = fileURLToPath(new URL("../extension.js", import.meta.url));
  readonly #run: CommandRunner;

  constructor(ompPath: string, run: CommandRunner = runCommand) {
    this.#ompPath = ompPath;
    this.#run = run;
  }

  async launch(request: SessionLaunchRequest): Promise<SessionLaunchResult> {
    const normalized = normalizeLaunchRequest(request);
    try {
      accessSync(this.#ompPath, constants.X_OK);
    } catch {
      throw new Error(`OMP executable is not available: ${this.#ompPath}`);
    }

    const result = await this.#run(
      "tmux",
      buildTmuxArguments(normalized, this.#ompPath, this.#extensionPath),
    );
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `tmux exited with code ${result.code}`;
      throw new Error(detail);
    }
    return { name: normalized.name, cwd: normalized.cwd };
  }

  async listOmpSessions(): Promise<OmpTmuxSession[]> {
    const result = await this.#run("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}\t#{pane_current_command}",
    ]);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `tmux exited with code ${result.code}`;
      throw new Error(detail);
    }
    return parseOmpTmuxSessions(result.stdout);
  }

  async enableSlackoff(paneId: string): Promise<OmpTmuxSession> {
    const session = (await this.listOmpSessions()).find((candidate) => candidate.paneId === paneId);
    if (!session) throw new Error("The selected OMP tmux pane is no longer available");

    const input = await this.#run("tmux", ["send-keys", "-t", paneId, "-l", "/slackoff on"]);
    if (input.code !== 0) throw new Error(input.stderr.trim() || `tmux exited with code ${input.code}`);
    const enter = await this.#run("tmux", ["send-keys", "-t", paneId, "Enter"]);
    if (enter.code !== 0) throw new Error(enter.stderr.trim() || `tmux exited with code ${enter.code}`);
    return session;
  }

  async killOmpSession(name: string): Promise<void> {
    const session = (await this.listOmpSessions()).find((candidate) => candidate.name === name);
    if (!session) throw new Error(`OMP tmux session is no longer available: ${name}`);
    const result = await this.#run("tmux", ["kill-session", "-t", `=${session.name}`]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `tmux exited with code ${result.code}`);
  }
}

export function parseOmpTmuxSessions(output: string): OmpTmuxSession[] {
  const sessions = new Map<string, OmpTmuxSession>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, name, command] = line.split("\t");
    if (!paneId || !name || command !== "omp" || !/^%\d+$/.test(paneId) || sessions.has(name)) continue;
    sessions.set(name, { name, paneId });
  }
  return [...sessions.values()].sort((left, right) => left.name.localeCompare(right.name));
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

export function buildTmuxArguments(
  request: SessionLaunchRequest,
  ompPath: string,
  extensionPath: string,
): string[] {
  const environment = [
    "-e",
    "SLACKOFF_AUTO_ENABLE=1",
    "-e",
    `SLACKOFF_OMP_PATH=${ompPath}`,
    "-e",
    `SLACKOFF_EXTENSION_PATH=${extensionPath}`,
    "-e",
    `SLACKOFF_CWD=${request.cwd}`,
  ];
  if (request.prompt) environment.push("-e", `SLACKOFF_INITIAL_PROMPT=${request.prompt}`);
  const command = request.prompt
    ? 'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD" --extension "$SLACKOFF_EXTENSION_PATH" "$SLACKOFF_INITIAL_PROMPT"'
    : 'exec "$SLACKOFF_OMP_PATH" --allow-home --cwd "$SLACKOFF_CWD" --extension "$SLACKOFF_EXTENSION_PATH"';
  return ["new-session", "-d", "-s", request.name, "-c", request.cwd, ...environment, command];
}

function runCommand(program: string, args: string[]): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 64_000) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_000) stderr += chunk;
  });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  return promise;
}
