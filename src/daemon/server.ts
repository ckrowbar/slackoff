import type { Socket } from "node:net";

import type { DaemonConfig } from "../config.js";
import { ClientMessageSchema, encodeMessage, type ClientMessage, type ResponseMessage } from "../protocol.js";
import { SessionRegistry } from "./registry.js";
import { SlackController } from "./slack.js";
import { OwnedUnixServer } from "./owned-unix-server.js";

export class SlackoffDaemon {
  readonly #config: DaemonConfig;
  readonly #registry = new SessionRegistry();
  readonly #slack: SlackController;
  readonly #ipcServer: OwnedUnixServer;
  readonly #connections = new Set<Socket>();

  constructor(config: DaemonConfig) {
    this.#config = config;
    this.#slack = new SlackController(config, this.#registry);
    this.#ipcServer = new OwnedUnixServer(config.socketPath);
  }

  async start(): Promise<void> {
    await this.#ipcServer.listen((socket) => this.#handleConnection(socket));

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
    await this.#ipcServer.close();
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
            const raw: unknown = JSON.parse(line);
            const parsed = ClientMessageSchema.safeParse(raw);
            if (!parsed.success) {
              const requestId =
                typeof raw === "object" &&
                raw !== null &&
                "requestId" in raw &&
                typeof raw.requestId === "string"
                  ? raw.requestId
                  : undefined;
              const protocolVersion =
                typeof raw === "object" && raw !== null && "protocolVersion" in raw
                  ? ` (received protocolVersion ${String(raw.protocolVersion)})`
                  : "";
              if (requestId) {
                this.#respond(socket, {
                  type: "response",
                  requestId,
                  ok: false,
                  error: `Invalid Slackoff client message${protocolVersion}: ${parsed.error.message}`,
                });
                return;
              }
              throw new Error(`Invalid Slackoff client message: ${parsed.error.message}`);
            }
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
        const update = (async () => {
          await this.#slack.abortBtwRequests(record);
          if (record.pendingQuestion) {
            await this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, "offline");
          } else {
            await this.#slack.refreshRoot(record);
          }
        })();
        void update.catch((error) => console.error("Slackoff offline update failed", error));
      }
      this.#slack.scheduleHomeRefresh();
    });
  }

  async #handleMessage(socket: Socket, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "register": {
        try {
          const session = this.#slack.claimTmuxAttachment(message.session);
          const binding = await this.#slack.ensureBinding(
            session,
            message.binding,
            message.status,
            message.activity,
          );
          const { record, replacedSocket } = this.#registry.register(
            session,
            binding,
            socket,
            message.status,
            message.activity,
          );
          if (replacedSocket) {
            replacedSocket.write(encodeMessage({ type: "replaced", sessionId: message.session.id, reason: "lease" }));
          }
          if (replacedSocket) await this.#slack.abortBtwRequests(record);
          if (replacedSocket && record.pendingQuestion) {
            await this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, "idle");
          }
          this.#respond(socket, { type: "response", requestId: message.requestId, ok: true, binding });
          this.#slack.completeTmuxAttachment(session.id);
          await this.#slack.refreshRoot(record);
          this.#slack.scheduleHomeRefresh();
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
        const active = this.#registry.getBySessionId(message.sessionId);
        if (active?.socket === socket) await this.#slack.abortBtwRequests(active);
        const record = this.#registry.unregister(message.sessionId, socket, status);
        if (record?.pendingQuestion) await this.#slack.cancelQuestion(record, record.pendingQuestion.questionId, status);
        else if (record) await this.#slack.refreshRoot(record);
        if (record) this.#slack.scheduleHomeRefresh();
        return;
      }
      case "session_title": {
        const record = this.#registry.updateTitle(message.sessionId, socket, message.title);
        if (!record) return;
        this.#slack.scheduleRootRefresh(record);
        this.#slack.scheduleHomeRefresh();
        return;
      }
      case "status": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        record.status = message.status;
        record.activity = message.activity;
        this.#slack.scheduleRootRefresh(record);
        this.#slack.scheduleHomeRefresh();
        return;
      }
      case "model_state": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        record.session.modelState = message.modelState;
        this.#slack.scheduleRootRefresh(record);
        if (message.error) await this.#slack.postModelError(record, message.error);
        return;
      }
      case "transcript": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.postTranscript(record, message.role, message.text);
        return;
      }
      case "btw_start": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.postBtwStart(record, message.requestId, message.question);
        return;
      }
      case "btw_update": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        this.#slack.postBtwUpdate(record, message.requestId, message.delta);
        return;
      }
      case "btw_end": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        await this.#slack.postBtwEnd(record, message);
        return;
      }
      case "command_ack": {
        const record = this.#registry.getBySessionId(message.sessionId);
        if (!record || record.socket !== socket) return;
        if (message.state === "failed") {
          await this.#slack.postCommandError(record, message.detail ?? "Unknown error");
        }
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
