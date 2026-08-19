import type { ModelEffort } from "../../../src/protocol.js";
import type { AppState, Controller, ModelOption, PendingQuestion, SessionView, StatusFilter, ThreadEvent, ThreadState } from "../types.js";

const MODEL_DATA: readonly (readonly [string, string, string])[] = [
  ["openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol"],
  ["openai-codex", "gpt-5.4", "GPT-5.4"],
  ["openai-codex", "gpt-5.3-codex", "GPT-5.3 Codex"],
  ["openai-codex", "gpt-5.2-codex", "GPT-5.2 Codex"],
  ["openai", "gpt-5.5", "GPT-5.5"],
  ["openai", "gpt-5.4-mini", "GPT-5.4 mini"],
  ["openai", "o4-mini", "o4-mini"],
  ["openai", "o3", "o3"],
  ["anthropic", "claude-opus-5", "Claude Opus 5"],
  ["anthropic", "claude-sonnet-5", "Claude Sonnet 5"],
  ["anthropic", "claude-haiku-4.5", "Claude Haiku 4.5"],
  ["anthropic", "claude-opus-4.6", "Claude Opus 4.6"],
  ["google", "gemini-3.1-pro", "Gemini 3.1 Pro"],
  ["google", "gemini-3-flash", "Gemini 3 Flash"],
  ["google", "gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["google", "gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["xai", "grok-4.2", "Grok 4.2"],
  ["xai", "grok-code-fast", "Grok Code Fast"],
  ["mistral", "devstral-2", "Devstral 2"],
  ["mistral", "codestral-25.08", "Codestral"],
  ["deepseek", "deepseek-v3.2", "DeepSeek V3.2"],
  ["deepseek", "deepseek-r1", "DeepSeek R1"],
  ["qwen", "qwen3-coder-next", "Qwen3 Coder Next"],
  ["qwen", "qwen3.5-397b", "Qwen3.5 397B"],
  ["meta", "llama-4-maverick", "Llama 4 Maverick"],
  ["meta", "llama-4-scout", "Llama 4 Scout"],
  ["cohere", "command-a", "Command A"],
  ["moonshot", "kimi-k2.5", "Kimi K2.5"],
  ["zai", "glm-5", "GLM-5"],
  ["minimax", "minimax-m2.5", "MiniMax M2.5"],
  ["amazon", "nova-premier", "Nova Premier"],
  ["local", "qwen3-coder-30b", "Qwen3 Coder 30B"],
];
const EFFORTS: ModelEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODELS: ModelOption[] = MODEL_DATA.map(([provider, id, name]) => ({ provider, id, name, selector: `${provider}/${id}` }));
const NOW = Date.now();
const minute = 60_000;

const question: PendingQuestion = {
  questionId: "question-release-scope",
  ts: "1710000000.000120",
  prompt: "Which release strategy should I implement for the migration?",
  options: [
    { label: "Feature flag", description: "Ship dark, enable for internal workspaces, then ramp gradually." },
    { label: "Direct cutover" },
    { label: "Dual-write period", description: "Keep both paths live until the audit window closes." },
  ],
  multi: false,
  askedAt: NOW - 2 * minute,
};
function sessionRank(item: SessionView): number {
  if (item.collapsed) return 4;
  if (item.pendingQuestion || item.status === "waiting") return 0;
  if (item.status === "working" || item.status === "stopping") return 1;
  if (item.status === "idle") return 2;
  return 3;
}


function session(
  sessionId: string,
  title: string,
  project: string,
  status: SessionView["status"],
  modelIndex: number,
  updatedMinutes: number,
  overrides: Partial<SessionView> = {},
): SessionView {
  return {
    sessionId,
    bindingId: `binding-${sessionId}`,
    channelId: "D08SLACKOFF",
    threadTs: `${1710000000 + modelIndex}.000100`,
    title,
    project,
    status,
    model: MODELS[modelIndex] ?? MODELS[0]!,
    effort: "high",
    models: MODELS,
    efforts: EFFORTS,
    collapsed: false,
    connected: true,
    startedAt: NOW - (90 + updatedMinutes) * minute,
    updatedAt: NOW - updatedMinutes * minute,
    unread: 0,
    controllable: true,
    ...overrides,
  };
}

const INITIAL_SESSIONS: SessionView[] = [
  session("019fec89f31d4e8c", "OMP 019fec89", "review-1776", "waiting", 8, 2, { activity: "Waiting", unread: 3, pendingQuestion: question }),
  session("f4a91ce070bb43e6", "Build Slackoff Console", "chrome-extension", "working", 0, 0, { activity: "Thinking" }),
  session("c26b18e4047c4932", "OMP c26b18e4", "bridge-v3", "idle", 1, 7),
  session("d95c1c3c47ef4417", "Investigate flaky socket reconnects", "slackoff", "done", 12, 48, { controllable: false }),
  session("e03fe91a6e124f55", "Repair transcript metadata parsing", "protocol-v3", "error", 4, 15, { activity: "Send failed", unread: 1 }),
  session("4ac79e2a13d04729", "OMP 4ac79e2a", "cleanup-431", "done", 9, 190, { collapsed: true, controllable: false }),
];

function event(ts: string, minutesAgo: number, kind: ThreadEvent["kind"], text: string, overrides: Partial<ThreadEvent> = {}): ThreadEvent {
  return { ts, at: NOW - minutesAgo * minute, kind, text, ...overrides };
}

const LONG_LINE = `A deliberately long diagnostic line from a minified source map: ${"frame.resolve(sourceOffset, generatedPosition) → ".repeat(18)}done.`;
const INITIAL_THREADS = new Map<string, ThreadState>([
  ["019fec89f31d4e8c", {
    sessionId: "019fec89f31d4e8c",
    loading: false,
    hasMore: false,
    events: [
      event("1710000000.000101", 18, "user", "Review the database migration and recommend the safest release strategy."),
      event("1710000000.000110", 14, "assistant", "I traced the read and write paths. The schema change is backwards-compatible, but the worker fleet can straddle two versions for about six minutes."),
      event("1710000000.000120", 2, "question", question.prompt, { question }),
    ],
  }],
  ["f4a91ce070bb43e6", {
    sessionId: "f4a91ce070bb43e6",
    loading: false,
    hasMore: true,
    oldestTs: "1710000001.000010",
    events: [
      event("1710000001.000010", 36, "user", "Build a dense, keyboard-first console for the Slackoff extension. Keep every untrusted transcript value out of innerHTML."),
      event("1710000001.000020", 32, "assistant", "## Rendering status\n\nThe renderer now supports **readable Markdown** without trusting raw HTML.\n\n- Semantic headings and lists\n- Safe [links](https://developer.mozilla.org/)\n- Inline `code` and ~~obsolete text~~\n\n> Raw HTML stays text, so `<img src=x onerror=alert(1)>` cannot execute."),
      event("1710000001.000030", 24, "notice", "Synced 14 earlier thread messages."),
      event("1710000001.000040", 18, "assistant", "The keyed update path keeps session rows and transcript events stable across state changes.\n\n```ts\nfunction reconcile(events: readonly ThreadEvent[]): void {\n  const live = new Set(events.map((event) => event.ts));\n  for (const [ts, node] of nodes) {\n    if (!live.has(ts)) node.remove();\n  }\n}\n```\n\nReference: https://developer.mozilla.org/en-US/docs/Web/API/Node/replaceChild."),
      event("1710000001.000050", 8, "assistant", LONG_LINE),
      event("1710000001.000060", 1, "assistant", "I am checking focus preservation, transcript scrolling, and the 32-model picker now.", { pending: true }),
    ],
  }],
  ["c26b18e4047c4932", {
    sessionId: "c26b18e4047c4932", loading: false, hasMore: false,
    events: [event("1710000002.000010", 9, "assistant", "Ready for the next instruction. The protocol v3 fixtures are loaded.")],
  }],
  ["d95c1c3c47ef4417", {
    sessionId: "d95c1c3c47ef4417", loading: false, hasMore: false,
    events: [
      event("1710000003.000010", 66, "user", "Find the source of the intermittent socket reconnect."),
      event("1710000003.000020", 48, "assistant", "The reconnect was caused by a stale close callback winning a race with the replacement socket. The generation guard now ignores callbacks from superseded connections."),
    ],
  }],
  ["e03fe91a6e124f55", {
    sessionId: "e03fe91a6e124f55", loading: false, hasMore: false,
    events: [
      event("1710000004.000010", 21, "user", "Parse the new flat metadata payload and preserve model options."),
      event("1710000004.000020", 15, "user", "Please retry against the latest root card.", { failed: "Slack returned a temporary rate-limit response." }),
    ],
  }],
  ["4ac79e2a13d04729", {
    sessionId: "4ac79e2a13d04729", loading: false, hasMore: false,
    events: [event("1710000005.000010", 190, "notice", "Thread closed from Slack.")],
  }],
]);

export function createFixtureController(): Controller {
  let sessions = INITIAL_SESSIONS.map((item) => ({ ...item }));
  const threads = new Map([...INITIAL_THREADS].map(([id, thread]) => [id, { ...thread, events: thread.events.map((item) => ({ ...item })) }]));
  let selectedSessionId: string | undefined = sessions[0]?.sessionId;
  let filter: StatusFilter = "all";
  let query = "";
  let notice: string | undefined;
  let busy = false;
  let running = false;
  const listeners = new Set<(state: AppState) => void>();
  const timers = new Set<number>();

  const getState = (): AppState => {
    const selected = sessions.find((item) => item.sessionId === selectedSessionId);
    const needle = query.trim().toLocaleLowerCase();
    const visibleSessions = sessions
      .filter((item) => {
        if (filter === "attention" && !item.pendingQuestion && item.status !== "waiting") return false;
        if (filter === "active" && !["waiting", "working", "stopping"].includes(item.status)) return false;
        if (!needle) return true;
        return `${item.title} ${item.project} ${item.model?.name ?? ""} ${item.model?.selector ?? ""}`.toLocaleLowerCase().includes(needle);
      })
      .sort((a, b) => sessionRank(a) - sessionRank(b) || b.updatedAt - a.updatedAt);
    const base: AppState = {
      connection: { phase: "ready", team: "Acme Engineering", lastSyncAt: Date.now() },
      sessions: visibleSessions,
      filter,
      query,
      attention: sessions.filter((item) => Boolean(item.pendingQuestion) || item.status === "waiting").sort((a, b) => b.updatedAt - a.updatedAt),
      busy,
    };
    if (selectedSessionId) base.selectedSessionId = selectedSessionId;
    const thread = selected ? threads.get(selected.sessionId) : undefined;
    if (thread) base.thread = thread;
    if (notice) base.notice = notice;
    return base;
  };

  const emit = (): void => {
    const state = getState();
    for (const listener of listeners) listener(state);
  };

  const later = (delay: number, action: () => void): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      action();
      resolve();
    }, delay);
    timers.add(timer);
    return promise;
  };

  const updateSession = (sessionId: string, change: (item: SessionView) => SessionView): void => {
    sessions = sessions.map((item) => item.sessionId === sessionId ? change(item) : item);
  };

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      running = true;
      emit();
    },
    stop() {
      running = false;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    },
    select(sessionId) {
      selectedSessionId = sessionId;
      if (sessionId) updateSession(sessionId, (item) => ({ ...item, unread: 0 }));
      emit();
    },
    setFilter(nextFilter) {
      filter = nextFilter;
      emit();
    },
    setQuery(nextQuery) {
      query = nextQuery;
      emit();
    },
    async refresh() {
      busy = true;
      emit();
      await later(280, () => {
        busy = false;
        notice = "Fixture data synced just now.";
        emit();
      });
    },
    async loadMore() {
      notice = "No earlier fixture messages remain.";
      emit();
    },
    async sendInstruction(sessionId, text) {
      if (!running) throw new Error("Fixture controller is stopped.");
      const thread = threads.get(sessionId);
      if (!thread) throw new Error("Thread not found.");
      const ts = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      thread.events = [...thread.events, { ts, at: Date.now(), kind: "user", text, pending: true }];
      updateSession(sessionId, (item) => ({ ...item, updatedAt: Date.now(), status: "working", activity: "Queued" }));
      emit();
      await later(360, () => {
        thread.events = thread.events.map((item) => item.ts === ts ? { ts: item.ts, at: item.at, kind: item.kind, text: item.text } : item);
        updateSession(sessionId, (item) => ({ ...item, activity: "Thinking" }));
        emit();
      });
    },
    async sendImages(sessionId, text, images) {
      await this.sendInstruction(
        sessionId,
        `${text.trim()}${text.trim() ? "\n\n" : ""}[Attached ${images.length} image${images.length === 1 ? "" : "s"}]`,
      );
    },
    async createSession(request) {
      if (!running) throw new Error("Fixture controller is stopped.");
      await later(600, () => {
        const sessionId = `fixture-${Date.now().toString(16)}`;
        const project = request.cwd.split("/").filter(Boolean).at(-1) ?? request.cwd;
        sessions = [
          session(sessionId, request.name, project, "working", 0, 0, {
            threadTs: `${Date.now() / 1000}`,
            activity: "Starting",
          }),
          ...sessions,
        ];
        threads.set(sessionId, {
          sessionId,
          loading: false,
          hasMore: false,
          events: request.prompt
            ? [event(`launch-${Date.now()}`, 0, "user", request.prompt)]
            : [],
        });
        selectedSessionId = sessionId;
        emit();
      });
    },
    async answerQuestion(sessionId, answers) {
      const thread = threads.get(sessionId);
      const current = sessions.find((item) => item.sessionId === sessionId)?.pendingQuestion;
      if (!thread || !current) throw new Error("This question is no longer pending.");
      updateSession(sessionId, (item) => {
        const { pendingQuestion: _pendingQuestion, ...rest } = item;
        return { ...rest, status: "working", activity: "Thinking", updatedAt: Date.now() };
      });
      thread.events = [...thread.events, event(`answer-${Date.now()}`, 0, "answered", `You answered: ${answers.join(", ")}`)];
      emit();
      await later(320, () => {
        thread.events = [...thread.events, event(`assistant-${Date.now()}`, 0, "assistant", `Understood — I’ll proceed with ${answers.join(" and ")}. I’ll call out any migration risk before changing the release path.`)];
        updateSession(sessionId, (item) => ({ ...item, status: "working", activity: "Implementing" }));
        emit();
      });
    },
    async stopTurn(sessionId) {
      updateSession(sessionId, (item) => ({ ...item, status: "stopping", activity: "Stopping" }));
      emit();
      await later(420, () => {
        updateSession(sessionId, (item) => ({ ...item, status: "idle", activity: "" }));
        const thread = threads.get(sessionId);
        if (thread) thread.events = [...thread.events, event(`stopped-${Date.now()}`, 0, "notice", "Turn stopped from the console.")];
        emit();
      });
    },
    async setModel(sessionId, selector) {
      const model = MODELS.find((item) => item.selector === selector);
      if (!model) throw new Error(`Unknown model: ${selector}`);
      updateSession(sessionId, (item) => ({ ...item, model, updatedAt: Date.now() }));
      notice = `Model switched to ${model.name}.`;
      emit();
    },
    async setEffort(sessionId, effort) {
      if (!EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
      updateSession(sessionId, (item) => ({ ...item, effort, updatedAt: Date.now() }));
      notice = `Model effort set to ${effort}.`;
      emit();
    },
    async closeThread(sessionId) {
      updateSession(sessionId, (item) => ({ ...item, collapsed: true, controllable: false, status: "done", activity: "" }));
      notice = "Thread closed. Slack history is unchanged.";
      emit();
    },
  };
}
