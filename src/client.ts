import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import type { ClientConfig } from "./config.js";
import {
  encodeMessage,
  ServerMessageSchema,
  type ClientMessage,
  type ResponseMessage,
  type ServerMessage,
} from "./protocol.js";

interface PendingRequest {
  resolve: (response: ResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BridgeClient {
  readonly #config: ClientConfig;
  readonly #listeners = new Set<(message: ServerMessage) => void>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #onError: (error: Error) => void;
  #socket: Socket | undefined;
  #buffer = "";
  #connecting: Promise<void> | undefined;

  constructor(config: ClientConfig, onError: (error: Error) => void = () => undefined) {
    this.#config = config;
    this.#onError = onError;
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed;
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.#connecting) return this.#connecting;

    this.#connecting = this.#connectOrStart().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  send(message: ClientMessage): boolean {
    if (!this.connected || !this.#socket) return false;
    this.#socket.write(encodeMessage(message));
    return true;
  }

  async request(message: ClientMessage & { requestId: string }, timeoutMs = 10_000): Promise<ResponseMessage> {
    await this.ensureConnected();

    const { promise, resolve, reject } = Promise.withResolvers<ResponseMessage>();
    const timeout = setTimeout(() => {
      this.#pending.delete(message.requestId);
      reject(new Error(`Slackoff daemon request timed out: ${message.type}`));
    }, timeoutMs);
    timeout.unref();
    this.#pending.set(message.requestId, { resolve, reject, timeout });

    if (!this.send(message)) {
      clearTimeout(timeout);
      this.#pending.delete(message.requestId);
      reject(new Error("Slackoff daemon disconnected before request delivery"));
    }
    return promise;
  }

  disconnect(): void {
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#rejectPending(new Error("Slackoff daemon connection closed"));
  }

  async #connectOrStart(): Promise<void> {
    try {
      await this.#connectOnce();
      return;
    } catch (error) {
      if (!isConnectionUnavailable(error)) throw error;
    }

    const daemonEntry = fileURLToPath(new URL("./daemon/main.js", import.meta.url));
    const child = spawn(this.#config.nodePath, [daemonEntry], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SLACKOFF_CONFIG: this.#config.configPath,
        SLACKOFF_SOCKET_PATH: this.#config.socketPath,
      },
    });
    child.unref();

    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
      try {
        await this.#connectOnce();
        return;
      } catch (error) {
        lastError = error;
        if (!isConnectionUnavailable(error)) throw error;
      }
    }

    throw new Error("Slackoff daemon did not start", { cause: lastError });
  }

  async #connectOnce(): Promise<void> {
    if (this.connected) return;

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = connect(this.#config.socketPath);
    const onConnectError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.off("error", onConnectError);
      this.#attach(socket);
      resolve();
    });
    await promise;
  }

  #attach(socket: Socket): void {
    this.#socket?.destroy();
    this.#socket = socket;
    this.#buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#consume(chunk));
    socket.on("error", (error) => this.#onError(error));
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      const error = new Error("Slackoff daemon disconnected");
      this.#rejectPending(error);
      for (const listener of this.#disconnectListeners) listener(error);
    });
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");

    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (!line) continue;

      try {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          this.#onError(new Error(`Invalid Slackoff daemon message: ${parsed.error.message}`));
          continue;
        }
        const message = parsed.data;
        if (message.type === "response") {
          const pending = this.#pending.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.#pending.delete(message.requestId);
            pending.resolve(message);
            continue;
          }
        }
        for (const listener of this.#listeners) listener(message);
      } catch (error) {
        this.#onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isConnectionUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET")
  );
}
