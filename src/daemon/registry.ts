import type { Socket } from "node:net";

import type { SessionDescriptor, SessionStatus, SlackBinding } from "../protocol.js";


export interface PendingQuestion {
  questionId: string;
  messageTs: string;
  prompt: string;
  multi: boolean;
  options: string[];
}

export interface ActiveSession {
  session: SessionDescriptor;
  binding: SlackBinding;
  socket: Socket | undefined;
  status: SessionStatus;
  activity: string | undefined;
  collapsed: boolean;
  pendingQuestion: PendingQuestion | undefined;
}

export interface RegistrationResult {
  record: ActiveSession;
  replacedSocket: Socket | undefined;
}

export class SessionRegistry {
  readonly #bySessionId = new Map<string, ActiveSession>();
  readonly #sessionIdByBinding = new Map<string, string>();
  readonly #sessionIdByThread = new Map<string, string>();

  register(session: SessionDescriptor, binding: SlackBinding, socket: Socket): RegistrationResult {
    const conflictingSessionId = this.#sessionIdByBinding.get(binding.bindingId);
    if (conflictingSessionId && conflictingSessionId !== session.id) {
      throw new Error("Slack binding is already assigned to a different OMP session");
    }

    const existing = this.#bySessionId.get(session.id);
    const replacedSocket = existing?.socket !== socket ? existing?.socket : undefined;
    if (existing && existing.binding.bindingId !== binding.bindingId) this.#removeIndexes(existing);

    const record: ActiveSession = existing ?? {
      session,
      binding,
      socket,
      status: "idle",
      activity: undefined,
      pendingQuestion: undefined,
      collapsed: false,
    };
    record.session = session;
    record.binding = binding;
    record.socket = socket;
    record.status = "idle";
    record.activity = undefined;
    record.collapsed = false;

    this.#bySessionId.set(session.id, record);
    this.#addIndexes(record);
    return { record, replacedSocket };
  }

  updateTitle(sessionId: string, socket: Socket, title: string): ActiveSession | undefined {
    const record = this.#bySessionId.get(sessionId);
    if (!record || record.socket !== socket || record.session.title === title) return undefined;
    record.session.title = title;
    return record;
  }

  unregister(sessionId: string, socket: Socket, status: "offline" | "disabled"): ActiveSession | undefined {
    const record = this.#bySessionId.get(sessionId);
    if (!record || record.socket !== socket) return undefined;
    record.socket = undefined;
    record.status = status;
    record.activity = undefined;
    record.collapsed = status === "disabled";
    return record;
  }

  disconnect(socket: Socket): ActiveSession[] {
    const disconnected: ActiveSession[] = [];
    for (const record of this.#bySessionId.values()) {
      if (record.socket !== socket) continue;
      record.socket = undefined;
      record.status = "offline";
      record.activity = undefined;
      disconnected.push(record);
    }
    return disconnected;
  }

  getBySessionId(sessionId: string): ActiveSession | undefined {
    return this.#bySessionId.get(sessionId);
  }

  getByBindingId(bindingId: string): ActiveSession | undefined {
    const sessionId = this.#sessionIdByBinding.get(bindingId);
    return sessionId ? this.#bySessionId.get(sessionId) : undefined;
  }

  getByThread(channelId: string, threadTs: string): ActiveSession | undefined {
    const sessionId = this.#sessionIdByThread.get(`${channelId}:${threadTs}`);
    return sessionId ? this.#bySessionId.get(sessionId) : undefined;
  }

  values(): IterableIterator<ActiveSession> {
    return this.#bySessionId.values();
  }

  #addIndexes(record: ActiveSession): void {
    this.#sessionIdByBinding.set(record.binding.bindingId, record.session.id);
    this.#sessionIdByThread.set(`${record.binding.channelId}:${record.binding.threadTs}`, record.session.id);
  }

  #removeIndexes(record: ActiveSession): void {
    this.#sessionIdByBinding.delete(record.binding.bindingId);
    this.#sessionIdByThread.delete(`${record.binding.channelId}:${record.binding.threadTs}`);
  }
}
