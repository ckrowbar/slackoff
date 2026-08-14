import type { SessionView, StatusFilter } from "../types.js";
import { element, formatRelativeTime, modelLabel, replaceChildren } from "./dom.js";

const GROUPS = ["Needs you", "Working", "Ready", "Done", "Closed"] as const;
type GroupName = (typeof GROUPS)[number];

function groupFor(session: SessionView): GroupName {
  if (session.collapsed) return "Closed";
  if (session.pendingQuestion || session.status === "waiting") return "Needs you";
  if (session.status === "working" || session.status === "stopping") return "Working";
  if (session.status === "idle") return "Ready";
  return "Done";
}

export function filterSessions(sessions: readonly SessionView[], filter: StatusFilter, query: string): SessionView[] {
  const needle = query.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => {
      if (filter === "attention" && groupFor(session) !== "Needs you") return false;
      if (filter === "active" && !["waiting", "working", "stopping"].includes(session.status)) return false;
      if (!needle) return true;
      return `${session.title} ${session.project} ${session.model?.name ?? ""} ${session.model?.selector ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((a, b) => GROUPS.indexOf(groupFor(a)) - GROUPS.indexOf(groupFor(b)) || b.updatedAt - a.updatedAt);
}

interface SessionRow {
  node: HTMLButtonElement;
  dot: HTMLSpanElement;
  title: HTMLSpanElement;
  meta: HTMLSpanElement;
  time: HTMLTimeElement;
  unread: HTMLSpanElement;
}

export class SessionList {
  readonly node = element("nav", "session-list", { ariaLabel: "Sessions" });
  #rows = new Map<string, SessionRow>();
  #sections = new Map<GroupName, HTMLElement>();
  #bodies = new Map<GroupName, HTMLElement>();
  #select: (sessionId: string) => void;

  constructor(select: (sessionId: string) => void) {
    this.#select = select;
    for (const group of GROUPS) {
      const section = element("section", "session-group");
      const heading = element("h2", "session-group__title", { text: group });
      const body = element("div", "session-group__rows");
      section.append(heading, body);
      this.#sections.set(group, section);
      this.#bodies.set(group, body);
    }
  }

  update(sessions: readonly SessionView[], selectedSessionId: string | undefined, now = Date.now()): void {
    const byGroup = new Map<GroupName, SessionView[]>(GROUPS.map((group) => [group, []]));
    for (const session of sessions) byGroup.get(groupFor(session))?.push(session);

    const live = new Set(sessions.map((session) => session.sessionId));
    for (const [sessionId, row] of this.#rows) {
      if (live.has(sessionId)) continue;
      row.node.onclick = null;
      row.node.remove();
      this.#rows.delete(sessionId);
    }

    const visibleSections: Node[] = [];
    for (const group of GROUPS) {
      const groupSessions = byGroup.get(group) ?? [];
      if (groupSessions.length === 0) continue;
      const body = this.#bodies.get(group);
      const section = this.#sections.get(group);
      if (!body || !section) continue;
      const nodes = groupSessions.map((session) => {
        const row = this.#row(session.sessionId);
        this.#updateRow(row, session, selectedSessionId === session.sessionId, now);
        return row.node;
      });
      replaceChildren(body, nodes);
      visibleSections.push(section);
    }
    replaceChildren(this.node, visibleSections);
  }

  destroy(): void {
    for (const row of this.#rows.values()) row.node.onclick = null;
    this.#rows.clear();
    this.node.remove();
  }

  #row(sessionId: string): SessionRow {
    const cached = this.#rows.get(sessionId);
    if (cached) return cached;
    const node = element("button", "session-row", { type: "button" });
    const dot = element("span", "status-dot", { ariaLabel: "" });
    const title = element("span", "session-row__title");
    const meta = element("span", "session-row__meta");
    const time = element("time", "session-row__time");
    const unread = element("span", "session-row__unread");
    node.append(dot, title, meta, time, unread);
    node.onclick = () => this.#select(sessionId);
    const row = { node, dot, title, meta, time, unread };
    this.#rows.set(sessionId, row);
    return row;
  }

  #updateRow(row: SessionRow, session: SessionView, selected: boolean, now: number): void {
    row.node.classList.toggle("is-selected", selected);
    row.node.setAttribute("aria-current", selected ? "page" : "false");
    row.node.dataset.status = session.status;
    row.dot.dataset.status = session.status;
    row.dot.setAttribute("aria-label", session.status);
    row.title.textContent = session.title;
    row.meta.textContent = `${session.project || "Unknown project"} · ${modelLabel(session.model)}`;
    row.time.textContent = formatRelativeTime(session.updatedAt, now);
    row.time.dateTime = new Date(session.updatedAt).toISOString();
    row.unread.textContent = session.unread > 99 ? "99+" : String(session.unread);
    row.unread.hidden = session.unread === 0;
    row.node.title = `${session.title}\n${row.meta.textContent ?? ""}`;
  }
}
