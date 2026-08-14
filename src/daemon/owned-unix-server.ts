import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

interface SocketIdentity {
  dev: number;
  ino: number;
}

type SocketPathState = "owned" | "missing" | "replaced";

export class OwnedUnixServer {
  readonly #socketPath: string;
  #server: Server | undefined;
  #lockServer: Server | undefined;
  #identity: SocketIdentity | undefined;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  async listen(listener: (socket: Socket) => void): Promise<void> {
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });

    const lockServer = createServer();
    try {
      await listenServer(lockServer, daemonLockName(this.#socketPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(`Slackoff daemon is already running at ${this.#socketPath}`, { cause: error });
      }
      throw error;
    }
    this.#lockServer = lockServer;

    let server: Server | undefined;
    try {
      if (existsSync(this.#socketPath)) {
        if (await socketAcceptsConnections(this.#socketPath)) {
          throw new Error(`Slackoff daemon is already running at ${this.#socketPath}`);
        }
        unlinkSync(this.#socketPath);
      }

      server = createServer(listener);
      await listenServer(server, this.#socketPath);
      this.#server = server;
      chmodSync(this.#socketPath, 0o600);
      const { dev, ino } = lstatSync(this.#socketPath);
      this.#identity = { dev, ino };
    } catch (error) {
      if (server?.listening) await closeServer(server);
      this.#server = undefined;
      this.#identity = undefined;
      await closeServer(lockServer);
      this.#lockServer = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server) {
      const pathState = this.#socketPathState();
      if (pathState === "replaced") {
        console.warn(`Slackoff socket ownership changed; preserving replacement at ${this.#socketPath}`);
        server.unref();
      } else {
        await closeServer(server);
        this.#server = undefined;
        this.#identity = undefined;
      }
    }

    if (this.#lockServer) {
      await closeServer(this.#lockServer);
      this.#lockServer = undefined;
    }
  }

  #socketPathState(): SocketPathState {
    if (!existsSync(this.#socketPath)) return "missing";
    const identity = this.#identity;
    if (!identity) return "replaced";
    const current = lstatSync(this.#socketPath);
    return current.dev === identity.dev && current.ino === identity.ino ? "owned" : "replaced";
  }
}

function daemonLockName(socketPath: string): string {
  const digest = createHash("sha256").update(socketPath).digest("hex");
  return `\0slackoff-${digest}`;
}

async function listenServer(server: Server, path: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (error: Error): void => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off("error", onError);
    resolve();
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(path);
  return promise;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(socketPath);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
}
