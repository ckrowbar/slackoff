import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { DaemonConfig } from "../config.js";
import { ClientMessageSchema, encodeMessage, type ClientMessage, type ResponseMessage } from "../protocol.js";
import { SessionRegistry } from "./registry.js";
import { SlackController } from "./slack.js";

export class SlackoffDaemon {
  readonly #config: DaemonConfig;
  readonly #registry = new SessionRegistry();
  readonly #slack: SlackController;
  #server: Server | undefined;
  readonly #connections = new Set<Socket>();

  constructor(config: DaemonConfig) {
    this.#config = config;
    this.#slack = new SlackController(config, this.#registry);
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.#config.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.#config.socketPath)) {
      if (await socketAcceptsConnections(this.#config.socketPath)) {
        throw new Error(`Slackoff daemon is already running at ${this.#config.socketPath}`);
      }
      unlinkSync(this.#config.socketPath);
    }

    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen(this.#config.socketPath, () => resolve());
    await promise;
    chmodSync(this.#config.socketPath, 0o600);

    try {
      await this.#slack.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.#slack.stop().catch((error) => console.error("Slackoff Socket Mode shutdown failed", error));
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    if (this.#server) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#server.close(() => resolve());
      await promise;
      this.#server = undefined;
    }
    if (existsSync(this.#config.socketPath)) unlinkSync(this.#config.socketPath);
  }

  #handleConnection(socket: Socket): void {
    this.#connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let processing = Promise.resolve();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        processing = processing
          .then(async () => {
            const parsed = ClientMessageSchema.safeParse(JSON.parse(line));
            if (!parsed.success) throw new Error(`Invalid Slackoff client message: ${parsed.error.message}`);
            await this.#handleMessage(socket, parsed.data);
          })
          .catch((error) => {
            console.error("Slackoff IPC message failed", error);
            socket.destroy();
          });
      }
    });

    socket.on("error", (error) => console.error("Slackoff IPC socket error", error));
    socket.on("close", () => {
      this.#connections.delete(socket);
      for (const record of this.#registry.disconnect(socket)) {
        const update = record.pendingQuestion
          ? this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, "offline")
          : this.#slack.refreshRoot(record);
        void update.catch((error) => console.error("Slackoff offline update failed", error));
      }
    });
  }

  async #handleMessage(socket: Socket, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "register": {
        try {
          const binding = await this.#slack.ensureBinding(message.session, message.binding);
          const { record, replacedSocket } = this.#registry.register(message.session, binding, socket);
          if (replacedSocket) {
            replacedSocket.write(encodeMessage({ type: "replaced", sessionId: message.session.id }));
          }
          if (replacedSocket && record.pendingQuestion) {
            await this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, "idle");
          }
          this.#respond(socket, { type: "response", requestId: message.requestId, ok: true, binding });
          await this.#slack.refreshRoot(record);
        } catch (error) {
          this.#respond(socket, {
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "unregister": {
        const status = message.reason === "disabled" ? "disabled" : "offline";
        const record = this.#registry.unregister(message.sessionId, socket, status);
        if (record?.pendingQuestion) await this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, status);
        else if (record) await this.#slack.refreshRoot(record);
        return;
      }
      case "status": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        record.status = message.status;
        record.activity = message.activity;
        this.#slack.scheduleRootRefresh(record);
        return;
      }
      case "transcript": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.postTranscript(record, message.role, message.text);
        return;
      }
      case "command_ack": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.applyCommandAcknowledgement(record, message);
        return;
      }
      case "question": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) {
          this.#respond(socket, {
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: "OMP session is not registered on this connection",
          });
          return;
        }
        try {
          await this.#slack.postQuestion(record, message);
          this.#respond(socket, { type: "response", requestId: message.requestId, ok: true });
        } catch (error) {
          this.#respond(socket, {
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "cancel_question": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.cancelQuestion(record, message.questionId);
        return;
      }
      case "ping":
        this.#respond(socket, { type: "response", requestId: message.requestId, ok: true });
        return;
    }
  }

  #respond(socket: Socket, response: ResponseMessage): void {
    socket.write(encodeMessage(response));
  }
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
