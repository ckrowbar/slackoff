// Block Kit builders for Slackoff's cards, modals and App Home.
import { markdownToSlackMessages } from "./format/markdown.ts";
import { escapeMrkdwn, truncate } from "./format/mrkdwn.ts";
import type {
  ActionElement,
  ButtonElement,
  HomeView,
  KnownBlock,
  ModalView,
  Option,
  PlainText,
  SlackMessage,
  StaticSelectElement,
} from "./slack/types.ts";

export const ACTION = {
  model: "slackoff_model",
  effort: "slackoff_effort",
  stop: "slackoff_stop",
  open: "slackoff_open",
  close: "slackoff_close",
  resume: "slackoff_resume",
  approve: "slackoff_approve",
  answer: "slackoff_answer",
  answerModal: "slackoff_answer_modal",
  homeNew: "slackoff_home_new",
  homeMirror: "slackoff_home_mirror",
  link: "slackoff_link",
} as const;

export const VIEW = {
  answer: "slackoff_answer_view",
  newThread: "slackoff_new_view",
  mirror: "slackoff_mirror_view",
} as const;

export const NEW_THREAD_FIELDS = {
  projectBlock: "project",
  projectInput: "project_input",
  promptBlock: "prompt",
  promptInput: "prompt_input",
} as const;

export const MIRROR_FIELDS = { block: "thread", input: "thread_input" } as const;

export type CardStatus =
  | "starting"
  | "working"
  | "waiting"
  | "stopping"
  | "idle"
  | "done"
  | "error"
  | "archived"
  | "closed";

const STATUS_LABEL: Record<CardStatus, string> = {
  starting: "🔵 Starting",
  working: "🔵 Working",
  waiting: "🟡 Waiting for you",
  stopping: "🟠 Stopping",
  idle: "⚪ Ready",
  done: "🟢 Done",
  error: "🔴 Error",
  archived: "🗄️ Archived",
  closed: "⚫ Not mirrored",
};

export function statusLabel(status: CardStatus): string {
  return STATUS_LABEL[status];
}

export interface ModelChoice {
  id: string;
  name: string;
}

export interface ThreadCardState {
  threadId: string;
  title: string;
  projectName: string;
  status: CardStatus;
  activity?: string | undefined;
  model?: ModelChoice | undefined;
  effort?: string | undefined;
  models: readonly ModelChoice[];
  efforts: readonly string[];
  /** Web link to the thread when BB has a public app URL. */
  appLink?: string | undefined;
  enabled: boolean;
}

const plain = (text: string, maximum = 75): PlainText => ({ type: "plain_text", text: truncate(text, maximum), emoji: true });

function option(text: string, value: string): Option {
  return { text: plain(text), value };
}

export function buildThreadCard(state: ThreadCardState): SlackMessage {
  const title = state.title || "Untitled thread";
  const status = state.activity && isLive(state.status) ? `${STATUS_LABEL[state.status]} · ${state.activity}` : STATUS_LABEL[state.status];
  const text = `${title} · ${state.enabled ? status : STATUS_LABEL.closed}`;

  if (!state.enabled) {
    return {
      text,
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: `⚫ *${escapeMrkdwn(truncate(title, 150))}* · Not mirrored · ${escapeMrkdwn(state.projectName)}` }] },
        { type: "actions", block_id: `ctl:${state.threadId}`, elements: [button(ACTION.resume, "Resume mirroring", state.threadId)] },
      ],
    };
  }

  const model = state.model ? `${escapeMrkdwn(state.model.name)}${state.effort ? ` · ${escapeMrkdwn(state.effort)}` : ""}` : "Default";
  const blocks: KnownBlock[] = [
    { type: "header", text: plain(title, 150) },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${escapeMrkdwn(truncate(status, 400))}` },
        { type: "mrkdwn", text: `*Project*\n${escapeMrkdwn(state.projectName)}` },
        { type: "mrkdwn", text: `*Model*\n${model}` },
      ],
    },
  ];

  const elements: ActionElement[] = [];
  if (state.status !== "archived") {
    const modelSelect = select(ACTION.model, "Model", state.models.map((choice) => option(choice.name, choice.id)), state.model?.id);
    if (modelSelect) elements.push(modelSelect);
    const effortSelect = select(ACTION.effort, "Effort", state.efforts.map((level) => option(level, level)), state.effort);
    if (effortSelect) elements.push(effortSelect);
    if (isLive(state.status)) {
      elements.push({
        ...button(ACTION.stop, "Stop turn", state.threadId),
        confirm: {
          title: plain("Stop the running turn?"),
          text: { type: "mrkdwn", text: "The thread stays mirrored for your next message." },
          confirm: plain("Stop turn"),
          deny: plain("Keep running"),
        },
      });
    }
  }
  elements.push(
    state.appLink
      ? { type: "button", action_id: ACTION.link, text: plain("Open in BB"), url: state.appLink }
      : button(ACTION.open, "Show in BB", state.threadId),
  );
  elements.push({
    ...button(ACTION.close, "Stop mirroring", state.threadId),
    confirm: {
      title: plain("Stop mirroring this thread?"),
      text: { type: "mrkdwn", text: "The BB thread keeps running. Resume mirroring from this card or BB at any time." },
      confirm: plain("Stop mirroring"),
      deny: plain("Cancel"),
      style: "danger",
    },
  });
  blocks.push({ type: "actions", block_id: `ctl:${state.threadId}`, elements });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `BB thread \`${escapeMrkdwn(state.threadId)}\` · Reply in this thread to talk to the agent · \`!help\` for commands` }],
  });
  return { text, blocks };
}

function isLive(status: CardStatus): boolean {
  return status === "working" || status === "waiting" || status === "starting" || status === "stopping";
}

function button(actionId: string, text: string, value: string, style?: "primary" | "danger"): ButtonElement {
  return { type: "button", action_id: actionId, text: plain(text), value, ...(style ? { style } : {}) };
}

function select(actionId: string, placeholder: string, options: Option[], current: string | undefined): StaticSelectElement | undefined {
  const unique = new Map<string, Option>();
  for (const candidate of options) {
    if (candidate.value.length <= 150 && !unique.has(candidate.value)) unique.set(candidate.value, candidate);
  }
  const list = [...unique.values()].slice(0, 100);
  if (list.length < 2) return undefined;
  const initial = list.find((candidate) => candidate.value === current);
  return {
    type: "static_select",
    action_id: actionId,
    placeholder: plain(placeholder),
    options: list,
    ...(initial ? { initial_option: initial } : {}),
  };
}

// ---------------------------------------------------------------------------
// Turn progress

export interface ProgressStep {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
}

export interface PlanStep {
  step: string;
  status?: "pending" | "active" | "completed" | "failed" | undefined;
}

export interface ProgressState {
  finished: "completed" | "failed" | "interrupted" | undefined;
  startedAt: number;
  now: number;
  steps: readonly ProgressStep[];
  plan: readonly PlanStep[];
}

const VISIBLE_STEPS = 8;
const STEP_ICON: Record<ProgressStep["state"], string> = { running: "⏳", done: "✓", failed: "✗" };
const PLAN_ICON: Record<NonNullable<PlanStep["status"]>, string> = { pending: "☐", active: "▶", completed: "☑", failed: "✗" };

export function buildProgressCard(state: ProgressState): SlackMessage {
  const elapsed = formatDuration(state.now - state.startedAt);
  const count = `${state.steps.length} step${state.steps.length === 1 ? "" : "s"}`;
  const heading =
    state.finished === undefined
      ? `⏳ *Working* · ${count} · ${elapsed}`
      : state.finished === "completed"
        ? `✓ *Worked for ${elapsed}* · ${count}`
        : state.finished === "interrupted"
          ? `⏹ *Stopped after ${elapsed}* · ${count}`
          : `✗ *Failed after ${elapsed}* · ${count}`;
  const blocks: KnownBlock[] = [{ type: "context", elements: [{ type: "mrkdwn", text: heading }] }];

  if (state.plan.length > 0) {
    const lines = state.plan.slice(0, 20).map((step) => `${PLAN_ICON[step.status ?? "pending"]} ${escapeMrkdwn(truncate(step.step, 140))}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Plan*\n${lines.join("\n")}` } });
  }
  const visible = state.steps.slice(-VISIBLE_STEPS);
  if (visible.length > 0) {
    const hidden = state.steps.length - visible.length;
    const lines = visible.map((step) => `${STEP_ICON[step.state]} ${escapeMrkdwn(truncate(step.label, 160))}`);
    if (hidden > 0) lines.unshift(`_${hidden} earlier step${hidden === 1 ? "" : "s"}_`);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(lines.join("\n"), 3_000) }] });
  }
  return { text: `${state.finished ? "Finished" : "Working"} · ${count}`, blocks };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Interactions

export type ApprovalDecision = "allow_once" | "allow_for_session" | "deny";

export interface ApprovalCardInput {
  threadId: string;
  interactionId: string;
  title: string;
  /** Markdown body: a plan, file scope or tool description. */
  body: string;
  /** Raw command text, shown verbatim. */
  code?: string | undefined;
  reason: string | null;
  decisions: readonly ApprovalDecision[];
  /** Set once resolved: the outcome line shown instead of buttons. */
  outcome?: string | undefined;
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  allow_once: "Allow once",
  allow_for_session: "Allow for session",
  deny: "Deny",
};

/** Longest command shown in full; anything longer must be approved in BB. */
const MAX_APPROVAL_CODE = 2_800;

export function buildApprovalCard(input: ApprovalCardInput): SlackMessage {
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `${input.outcome ? "🔐" : "🟡"} *${escapeMrkdwn(truncate(input.title, 200))}*` } },
  ];
  let complete = true;
  if (input.code !== undefined) {
    complete = input.code.length <= MAX_APPROVAL_CODE;
    blocks.push({
      type: "rich_text",
      elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: truncate(input.code, MAX_APPROVAL_CODE) || " " }] }],
    });
  }
  const body = markdownBlocks(input.body);
  complete &&= body.complete;
  blocks.push(...body.blocks);
  if (input.reason) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(truncate(input.reason, 1_000)) }] });
  if (input.outcome) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(input.outcome) }] });
  } else if (!complete) {
    // Never ask for approval of something the card cannot show in full.
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "This request is too long to show here. Review and answer it in BB." }] });
    blocks.push({ type: "actions", elements: [button(ACTION.open, "Show in BB", input.threadId)] });
  } else {
    const elements: ActionElement[] = input.decisions.map((decision) =>
      button(
        `${ACTION.approve}:${decision}`,
        DECISION_LABEL[decision],
        `${input.threadId}|${input.interactionId}|${decision}`,
        decision === "allow_once" ? "primary" : decision === "deny" ? "danger" : undefined,
      ),
    );
    if (elements.length > 0) blocks.push({ type: "actions", elements });
  }
  return { text: `${input.outcome ? "Resolved" : "Approval needed"}: ${input.title}`, blocks };
}

export interface QuestionInput {
  id: string;
  prompt: string;
  shortLabel?: string | undefined;
  multiSelect: boolean;
  allowFreeText: boolean;
  options: readonly { label: string; description?: string | undefined; value: string }[];
}

export interface QuestionCardInput {
  threadId: string;
  interactionId: string;
  questions: readonly QuestionInput[];
  outcome?: string | undefined;
}

const MAX_OPTION_BUTTONS = 5;

export function buildQuestionCard(input: QuestionCardInput): SlackMessage {
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: input.outcome ? "💬 *Question answered*" : "🟡 *The agent has a question*" } },
  ];
  input.questions.forEach((question, index) => {
    if (input.questions.length > 1) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${index + 1}. ${escapeMrkdwn(truncate(question.shortLabel ?? "Question", 150))}*` } });
    }
    blocks.push(...markdownBlocks(question.prompt).blocks);
    if (question.options.length > 0) {
      const lines = question.options.map((choice, optionIndex) => {
        const description = choice.description ? ` — ${escapeMrkdwn(truncate(choice.description, 200))}` : "";
        return `${optionIndex + 1}. *${escapeMrkdwn(truncate(choice.label, 150))}*${description}`;
      });
      blocks.push({ type: "section", text: { type: "mrkdwn", text: truncate(lines.join("\n"), 3_000) } });
    }
  });

  if (input.outcome) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(truncate(input.outcome, 2_000)) }] });
    return { text: "Question answered", blocks };
  }

  const reference = `${input.threadId}|${input.interactionId}`;
  const only = input.questions.length === 1 ? input.questions[0] : undefined;
  const elements: ActionElement[] = [];
  if (only && !only.multiSelect && only.options.length > 0 && only.options.length <= MAX_OPTION_BUTTONS) {
    only.options.forEach((choice, optionIndex) => {
      elements.push(button(`${ACTION.answer}:${optionIndex}`, truncate(choice.label, 75), `${reference}|0|${optionIndex}`, optionIndex === 0 ? "primary" : undefined));
    });
    if (only.allowFreeText) elements.push(button(ACTION.answerModal, "Other answer…", reference));
  } else {
    elements.push(button(ACTION.answerModal, "Answer", reference, "primary"));
  }
  blocks.push({ type: "actions", elements });
  const hint = only && (only.allowFreeText || only.options.length > 0) ? "You can also reply in this thread with an option number or your own answer." : "";
  if (hint) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: hint }] });
  return { text: `Question: ${truncate(input.questions[0]?.prompt ?? "", 200)}`, blocks };
}

export function buildAnswerModal(threadId: string, interactionId: string, questions: readonly QuestionInput[]): ModalView {
  const blocks: KnownBlock[] = [];
  questions.forEach((question, index) => {
    blocks.push(...markdownBlocks(question.prompt).blocks);
    const label = plain(question.shortLabel ?? `Answer ${questions.length > 1 ? index + 1 : ""}`.trim(), 2_000);
    const options = question.options.slice(0, 10).map((choice, optionIndex) => ({
      text: plain(choice.label),
      value: String(optionIndex),
      ...(choice.description ? { description: plain(choice.description) } : {}),
    }));
    if (options.length > 0) {
      blocks.push({
        type: "input",
        block_id: `q${index}`,
        label,
        optional: question.allowFreeText,
        element: question.multiSelect
          ? { type: "checkboxes", action_id: "choice", options }
          : { type: "radio_buttons", action_id: "choice", options },
      });
    }
    if (question.allowFreeText || options.length === 0) {
      blocks.push({
        type: "input",
        block_id: `q${index}_text`,
        label: plain(options.length > 0 ? "Or write your own answer" : label.text, 2_000),
        optional: options.length > 0,
        element: { type: "plain_text_input", action_id: "text", multiline: true },
      });
    }
  });
  return {
    type: "modal",
    callback_id: VIEW.answer,
    private_metadata: `${threadId}|${interactionId}`,
    title: plain("Answer the agent", 24),
    submit: plain("Send", 24),
    close: plain("Cancel", 24),
    blocks: blocks.slice(0, 100),
  };
}

export function buildPendingElsewhereCard(threadId: string, title: string, outcome?: string): SlackMessage {
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text: `🟡 *${escapeMrkdwn(truncate(title, 200))}* needs your input in BB.` } }];
  if (outcome) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(outcome) }] });
  else blocks.push({ type: "actions", elements: [button(ACTION.open, "Show in BB", threadId)] });
  return { text: `${title} needs your input in BB`, blocks };
}

function markdownBlocks(markdown: string): { blocks: KnownBlock[]; complete: boolean } {
  if (!markdown.trim()) return { blocks: [], complete: true };
  // Cards hold one message; keep the first chunk and note any truncation.
  const [first, ...rest] = markdownToSlackMessages(markdown, { maxChars: 2_500 });
  const blocks = first?.blocks ?? [];
  if (rest.length > 0) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "_Truncated. Open the thread in BB for the full text._" }] });
  return { blocks, complete: rest.length === 0 };
}

// ---------------------------------------------------------------------------
// App Home and launch modals

export interface HomeThread {
  title: string;
  projectName: string;
  status: CardStatus;
  activity?: string | undefined;
  permalink?: string | undefined;
}

export function buildHomeView(input: { threads: readonly HomeThread[]; notice?: string | undefined; canStartThreads: boolean }): HomeView {
  const blocks: KnownBlock[] = [
    { type: "header", text: plain("BB threads", 150) },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Each mirrored BB thread has its own thread in the Messages tab. Send a direct message to start a new BB thread.",
      },
    },
    {
      type: "actions",
      elements: [
        ...(input.canStartThreads ? [button(ACTION.homeNew, "New thread", "new", "primary")] : []),
        button(ACTION.homeMirror, "Mirror a thread", "mirror"),
      ],
    },
  ];
  if (input.notice) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(input.notice) }] });
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: plain(`Mirrored (${input.threads.length})`, 150) });
  if (input.threads.length === 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No threads are mirrored yet." }] });
  }
  for (const thread of input.threads.slice(0, 40)) {
    const title = escapeMrkdwn(truncate(thread.title || "Untitled thread", 150));
    const link = thread.permalink ? `*<${thread.permalink}|${title}>*` : `*${title}*`;
    const status = thread.activity ? `${STATUS_LABEL[thread.status]} · ${thread.activity}` : STATUS_LABEL[thread.status];
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${link}\n${escapeMrkdwn(truncate(status, 300))} · ${escapeMrkdwn(thread.projectName)}` },
    });
  }
  return { type: "home", blocks: blocks.slice(0, 100) };
}

export function buildNewThreadModal(projects: readonly { id: string; name: string }[], defaultProjectId: string | undefined, prompt = ""): ModalView {
  const options = projects.slice(0, 100).map((project) => option(project.name, project.id));
  const initial = options.find((candidate) => candidate.value === defaultProjectId);
  return {
    type: "modal",
    callback_id: VIEW.newThread,
    title: plain("New BB thread", 24),
    submit: plain("Start", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: NEW_THREAD_FIELDS.projectBlock,
        label: plain("Project"),
        element: {
          type: "static_select",
          action_id: NEW_THREAD_FIELDS.projectInput,
          placeholder: plain("Choose a project"),
          options,
          ...(initial ? { initial_option: initial } : {}),
        },
      },
      {
        type: "input",
        block_id: NEW_THREAD_FIELDS.promptBlock,
        label: plain("What should the agent do?"),
        element: {
          type: "plain_text_input",
          action_id: NEW_THREAD_FIELDS.promptInput,
          multiline: true,
          ...(prompt ? { initial_value: truncate(prompt, 3_000) } : {}),
        },
      },
    ],
  };
}

export function buildMirrorModal(threads: readonly { id: string; title: string; projectName: string }[]): ModalView {
  if (threads.length === 0) {
    return {
      type: "modal",
      callback_id: VIEW.mirror,
      title: plain("Mirror a thread", 24),
      close: plain("Close", 24),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Every recent BB thread is already mirrored." } }],
    };
  }
  return {
    type: "modal",
    callback_id: VIEW.mirror,
    title: plain("Mirror a thread", 24),
    submit: plain("Mirror", 24),
    close: plain("Cancel", 24),
    blocks: [
      {
        type: "input",
        block_id: MIRROR_FIELDS.block,
        label: plain("BB thread"),
        element: {
          type: "static_select",
          action_id: MIRROR_FIELDS.input,
          placeholder: plain("Choose a thread"),
          options: threads.slice(0, 100).map((thread) => option(`${thread.title || "Untitled"} · ${thread.projectName}`, thread.id)),
        },
      },
    ],
  };
}
