import type { Socket } from "node:net";

import type { SessionDescriptor, SessionStatus, SlackBinding } from "../protocol.js";


export interface PendingQuestion {
  questionId: string;
  messageTs: string;
  prompt: string;
  multi: boolean;
  options: string[];
}
export type BtwOutcome = "completed" | "aborted" | "error";
const FINISHED_BTW_REQUEST_LIMIT = 128;


export interface BtwRequest {
  requestId: string;
  question: string;
  answer: string;
  channelId: string;
  threadTs: string;
  bindingId: string;
  messageTs: string | undefined;
  outcome: BtwOutcome | undefined;
  error: string | undefined;
}


export interface ActiveSession {
  session: SessionDescriptor;
  binding: SlackBinding;
  socket: Socket | undefined;
  status: SessionStatus;
  activity: string | undefined;
  collapsed: boolean;
  pendingQuestion: PendingQuestion | undefined;
  btwRequests: Map<string, BtwRequest>;
  finishedBtwRequestIds: Set<string>;
}
export function startBtwRequest(record: ActiveSession, requestId: string, question: string): BtwRequest | undefined {
  if (record.btwRequests.has(requestId) || record.finishedBtwRequestIds.has(requestId)) return undefined;
  const request: BtwRequest = {
    requestId,
    question,
    answer: "",
    channelId: record.binding.channelId,
    threadTs: record.binding.threadTs,
    bindingId: record.binding.bindingId,
    messageTs: undefined,
    outcome: undefined,
    error: undefined,
  };
  record.btwRequests.set(requestId, request);
  return request;
}

export function appendBtwDelta(record: ActiveSession, requestId: string, delta: string): BtwRequest | undefined {
  const request = record.btwRequests.get(requestId);
  if (!request || request.outcome) return undefined;
  request.answer += delta;
  return request;
}

export function finishBtwRequest(
  record: ActiveSession,
  requestId: string,
  end: { question: string; outcome: BtwOutcome; answer?: string | undefined; error?: string | undefined },
): BtwRequest | undefined {
  const request = record.btwRequests.get(requestId);
  if (!request || request.outcome) return undefined;
  request.question = end.question;
  request.outcome = end.outcome;
  request.error = end.outcome === "error" ? (end.error ?? "Unknown error") : undefined;
  if (end.outcome === "completed" && end.answer !== undefined) request.answer = end.answer;
  return request;
}

export function abortBtwRequests(record: ActiveSession): BtwRequest[] {
  const aborted: BtwRequest[] = [];
  for (const request of record.btwRequests.values()) {
    if (request.outcome) continue;
    request.outcome = "aborted";
    aborted.push(request);
  }
  return aborted;
}
export function completeBtwRequest(record: ActiveSession, request: BtwRequest): void {
  if (record.btwRequests.get(request.requestId) !== request) return;
  record.btwRequests.delete(request.requestId);
  record.finishedBtwRequestIds.add(request.requestId);
  if (record.finishedBtwRequestIds.size <= FINISHED_BTW_REQUEST_LIMIT) return;
  const oldest = record.finishedBtwRequestIds.values().next().value;
  if (oldest !== undefined) record.finishedBtwRequestIds.delete(oldest);
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
      btwRequests: new Map(),
      finishedBtwRequestIds: new Set(),
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
