import type { ModelOption, SessionView } from "../types.js";
import { element, modelLabel, replaceChildren } from "./dom.js";

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  keywords: string;
  priority: number;
  run: () => void;
}

interface PaletteActions {
  jump(sessionId: string): void;
  stop(sessionId: string): void;
  setModel(sessionId: string, selector: string): void;
  close(sessionId: string): void;
  refresh(): void;
  toggleTheme(): void;
}

export function fuzzyScore(query: string, candidate: string): number {
  const needle = query.trim().toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  if (!needle) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 1000 - exact * 2 - (haystack.length - needle.length) * 0.05;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, from);
    if (index < 0) return Number.NEGATIVE_INFINITY;
    score += index === previous + 1 ? 12 : Math.max(1, 7 - (index - from));
    if (index === 0 || /[\s/_.-]/.test(haystack[index - 1] ?? "")) score += 8;
    previous = index;
    from = index + 1;
  }
  return score - haystack.length * 0.02;
}

export class CommandPalette {
  readonly node = element("div", "palette", { role: "presentation" });
  #dialog = element("section", "palette__dialog", { role: "dialog", ariaLabel: "Command palette", "aria-modal": "true" });
  #input = element("input", "palette__input", { type: "search", autocomplete: "off", spellcheck: "false", ariaLabel: "Filter commands" });
  #list = element("div", "palette__list", { role: "listbox" });
  #empty = element("div", "palette__empty", { text: "No matching commands" });
  #footer = element("footer", "palette__footer", { text: "↑↓ navigate · Enter choose · Esc close" });
  #sessions: readonly SessionView[] = [];
  #selected: SessionView | undefined;
  #actions: PaletteActions;
  #mode: "commands" | "models" = "commands";
  #items: PaletteItem[] = [];
  #active = 0;

  constructor(actions: PaletteActions) {
    this.#actions = actions;
    this.#dialog.append(this.#input, this.#list, this.#empty, this.#footer);
    this.node.append(this.#dialog);
    this.node.hidden = true;
    this.#input.oninput = () => {
      this.#active = 0;
      this.#renderItems();
    };
    this.node.onclick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target === this.node) {
        this.close();
        return;
      }
      const item = target.closest<HTMLElement>("[data-palette-index]");
      if (!item) return;
      const index = Number(item.dataset.paletteIndex);
      this.#items[index]?.run();
    };
  }

  update(sessions: readonly SessionView[], selected: SessionView | undefined): void {
    this.#sessions = sessions;
    this.#selected = selected;
    if (!this.node.hidden) this.#renderItems();
  }

  open(): void {
    this.#mode = "commands";
    this.#input.placeholder = "Jump to a session or run a command…";
    this.#input.value = "";
    this.#active = 0;
    this.node.hidden = false;
    this.#renderItems();
    requestAnimationFrame(() => this.#input.focus());
  }

  openModels(session = this.#selected): void {
    if (!session || session.models.length === 0) return;
    this.#selected = session;
    this.#mode = "models";
    this.#input.placeholder = `Switch model for ${session.title}…`;
    this.#input.value = "";
    this.#active = 0;
    this.node.hidden = false;
    this.#renderItems();
    requestAnimationFrame(() => this.#input.focus());
  }

  close(): void {
    this.node.hidden = true;
    this.#input.value = "";
  }

  toggle(): void {
    if (this.node.hidden) this.open();
    else this.close();
  }

  isOpen(): boolean {
    return !this.node.hidden;
  }

  handleKey(event: KeyboardEvent): boolean {
    if (this.node.hidden) return false;
    if (event.key === "Escape") {
      this.close();
      return true;
    }
    if (event.key === "ArrowDown") {
      this.#active = Math.min(this.#active + 1, Math.max(0, this.#items.length - 1));
      this.#syncActive();
      return true;
    }
    if (event.key === "ArrowUp") {
      this.#active = Math.max(0, this.#active - 1);
      this.#syncActive();
      return true;
    }
    if (event.key === "Enter") {
      this.#items[this.#active]?.run();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.#input.oninput = null;
    this.node.onclick = null;
    this.node.remove();
  }

  #renderItems(): void {
    const query = this.#input.value;
    const candidates = this.#mode === "models" ? this.#modelItems() : this.#commandItems();
    this.#items = candidates
      .map((item) => ({ item, score: fuzzyScore(query, `${item.label} ${item.keywords} ${item.detail}`) }))
      .filter(({ score }) => !query.trim() || Number.isFinite(score))
      .sort((a, b) => (b.score + b.item.priority) - (a.score + a.item.priority))
      .map(({ item }) => item)
      .slice(0, 60);
    this.#active = Math.min(this.#active, Math.max(0, this.#items.length - 1));
    const rows = this.#items.map((item, index) => {
      const row = element("button", "palette-item", { type: "button", role: "option", "aria-selected": String(index === this.#active), "data-palette-index": index });
      row.classList.toggle("is-active", index === this.#active);
      const copy = element("span", "palette-item__copy");
      copy.append(element("strong", "palette-item__label", { text: item.label }), element("span", "palette-item__detail", { text: item.detail }));
      row.append(copy, element("span", "palette-item__enter", { text: index === this.#active ? "↵" : "" }));
      return row;
    });
    replaceChildren(this.#list, rows);
    this.#empty.hidden = rows.length > 0;
  }

  #syncActive(): void {
    this.#list.querySelectorAll<HTMLElement>("[data-palette-index]").forEach((row, index) => {
      row.classList.toggle("is-active", index === this.#active);
      row.setAttribute("aria-selected", String(index === this.#active));
      const enter = row.querySelector<HTMLElement>(".palette-item__enter");
      if (enter) enter.textContent = index === this.#active ? "↵" : "";
    });
    this.#list.querySelector<HTMLElement>(`[data-palette-index="${this.#active}"]`)?.scrollIntoView({ block: "nearest" });
  }

  #commandItems(): PaletteItem[] {
    const items: PaletteItem[] = [];
    const selected = this.#selected;
    if (selected && (selected.status === "working" || selected.status === "waiting")) {
      items.push({ id: "stop", label: "Stop active turn", detail: selected.title, keywords: "halt cancel escape", priority: 180, run: () => { this.close(); this.#actions.stop(selected.sessionId); } });
    }
    if (selected?.models.length) {
      items.push({ id: "model", label: "Switch model…", detail: modelLabel(selected.model), keywords: `provider model ${selected.models.map((model) => model.selector).join(" ")}`, priority: 170, run: () => this.openModels(selected) });
    }
    if (selected && !selected.collapsed) {
      items.push({ id: "close", label: "Close thread…", detail: selected.title, keywords: "archive session", priority: 120, run: () => { this.close(); this.#actions.close(selected.sessionId); } });
    }
    items.push(
      { id: "refresh", label: "Retry sync", detail: "Refresh sessions and transcripts", keywords: "reload reconnect", priority: 100, run: () => { this.close(); this.#actions.refresh(); } },
      { id: "theme", label: "Cycle theme", detail: "Codex / Light / Slack", keywords: "appearance colour color", priority: 90, run: () => { this.close(); this.#actions.toggleTheme(); } },
    );
    const newest = Math.max(...this.#sessions.map((session) => session.updatedAt), 0);
    this.#sessions.forEach((session) => {
      const attention = session.pendingQuestion || session.status === "waiting";
      const recency = newest ? Math.max(0, 30 - (newest - session.updatedAt) / 60_000) : 0;
      items.push({
        id: `session:${session.sessionId}`,
        label: session.title,
        detail: `${session.project} · ${modelLabel(session.model)}`,
        keywords: `${session.status} ${session.activity} ${session.model?.selector ?? ""}`,
        priority: (attention ? 140 : 30) + recency,
        run: () => { this.close(); this.#actions.jump(session.sessionId); },
      });
    });
    return items;
  }

  #modelItems(): PaletteItem[] {
    const session = this.#selected;
    if (!session) return [];
    return session.models.map((model: ModelOption) => ({
      id: `model:${model.selector}`,
      label: model.name,
      detail: model.selector,
      keywords: `${model.provider} ${model.id}`,
      priority: model.selector === session.model?.selector ? 80 : 0,
      run: () => { this.close(); this.#actions.setModel(session.sessionId, model.selector); },
    }));
  }
}
