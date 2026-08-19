import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8734;
const USERSCRIPT_PATH = "/slackoff-console.user.js";
const USERSCRIPT_HEADER = "// ==UserScript==";

export interface UserscriptBuild {
  commit: string;
  source: string;
  trackingRef: string;
}

export interface InstallerServer {
  close(): Promise<void>;
  url: string;
}

interface RemoteTarget {
  branch: string;
  remote: string;
  trackingRef: string;
}

interface InstallerOptions {
  build: () => Promise<UserscriptBuild>;
  host?: string;
  port?: number;
  trackingRef: string;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveRemoteTarget(root: string, configuredRef?: string): RemoteTarget {
  const trackingRef = configuredRef ?? git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const separator = trackingRef.indexOf("/");
  if (separator <= 0 || separator === trackingRef.length - 1) {
    throw new Error(`Expected a remote branch such as origin/main, received ${trackingRef}`);
  }

  return {
    remote: trackingRef.slice(0, separator),
    branch: trackingRef.slice(separator + 1),
    trackingRef,
  };
}

export function buildRemoteUserscript(root: string, configuredRef?: string): UserscriptBuild {
  const target = resolveRemoteTarget(root, configuredRef);
  console.log(`Checking ${target.trackingRef} for the latest userscript...`);
  git(root, ["fetch", "--quiet", target.remote, target.branch]);
  const commit = git(root, ["rev-parse", "--verify", `${target.trackingRef}^{commit}`]);
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const cacheDirectory = join(cacheRoot, "slackoff", "userscripts");
  const cachedUserscript = join(cacheDirectory, `${commit}.user.js`);

  if (existsSync(cachedUserscript)) {
    const source = readFileSync(cachedUserscript, "utf8");
    if (source.startsWith(USERSCRIPT_HEADER)) return { commit, source, trackingRef: target.trackingRef };
  }

  const worktree = mkdtempSync(join(tmpdir(), "slackoff-userscript-"));
  let worktreeAdded = false;
  try {
    console.log(`Building ${target.trackingRef} at ${commit.slice(0, 12)}...`);
    git(root, ["worktree", "add", "--detach", "--force", worktree, commit]);
    worktreeAdded = true;
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: worktree,
      stdio: "inherit",
    });
    execFileSync("npm", ["run", "build:userscript"], { cwd: worktree, stdio: "inherit" });

    const source = readFileSync(join(worktree, "extension", "dist", "slackoff-console.user.js"), "utf8");
    if (!source.startsWith(USERSCRIPT_HEADER)) {
      throw new Error("Built userscript is missing its Tampermonkey metadata block");
    }
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(cachedUserscript, source, { mode: 0o600 });
    return { commit, source, trackingRef: target.trackingRef };
  } finally {
    if (worktreeAdded) git(root, ["worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

export async function startInstallerServer(options: InstallerOptions): Promise<InstallerServer> {
  let pendingBuild: Promise<UserscriptBuild> | undefined;
  const build = (): Promise<UserscriptBuild> => {
    pendingBuild ??= options.build().finally(() => {
      pendingBuild = undefined;
    });
    return pendingBuild;
  };

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }

    const pathname = new URL(request.url ?? "/", `http://${DEFAULT_HOST}`).pathname;
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(installerPage(options.trackingRef));
      return;
    }
    if (pathname !== USERSCRIPT_PATH) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    try {
      const userscript = await build();
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "X-Slackoff-Commit": userscript.commit,
      });
      response.end(userscript.source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Could not build the latest Slackoff userscript: ${message}\n`);
    }
  });

  await listen(server, options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Installer server did not bind to a TCP port");
  const url = `http://${options.host ?? DEFAULT_HOST}:${address.port}`;
  return { close: () => close(server), url };
}

function installerPage(trackingRef: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Install Slackoff Console</title></head>
<body style="font: 16px system-ui; max-width: 42rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
  <h1>Slackoff Console</h1>
  <p>This link fetches and builds the latest <code>${escapeHtml(trackingRef)}</code> revision, then opens Tampermonkey.</p>
  <p><a href="${USERSCRIPT_PATH}" style="display:inline-block;padding:.75rem 1rem;background:#4a154b;color:white;border-radius:.4rem;text-decoration:none">Install or update Slackoff Console</a></p>
  <p>Keep this terminal command running until Tampermonkey confirms the update.</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function listen(server: Server, port: number, host: string): Promise<void> {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    resolve();
  });
  return promise;
}

function close(server: Server): Promise<void> {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  return promise;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolveRemoteTarget(root, process.env.SLACKOFF_USERSCRIPT_UPSTREAM);
  const port = process.env.SLACKOFF_USERSCRIPT_PORT === undefined
    ? DEFAULT_PORT
    : Number.parseInt(process.env.SLACKOFF_USERSCRIPT_PORT, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("SLACKOFF_USERSCRIPT_PORT must be a valid TCP port");

  const installer = await startInstallerServer({
    build: async () => buildRemoteUserscript(root, target.trackingRef),
    port,
    trackingRef: target.trackingRef,
  });
  console.log(`Slackoff userscript installer: ${installer.url}`);
  if (process.env.SLACKOFF_USERSCRIPT_NO_OPEN !== "1") openBrowser(installer.url);

  const shutdown = async (): Promise<void> => {
    await installer.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
