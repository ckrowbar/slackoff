export type Attributes = Record<string, string | number | boolean | undefined>;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attributes: Attributes = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === "text") {
      node.textContent = String(value);
    } else if (name === "ariaLabel") {
      node.setAttribute("aria-label", String(value));
    } else if (name === "title") {
      node.title = String(value);
    } else if (name === "disabled" && value === true) {
      (node as HTMLButtonElement).disabled = true;
    } else {
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  return node;
}

export function replaceChildren(node: HTMLElement, children: readonly Node[]): void {
  const current = Array.from(node.childNodes);
  if (current.length === children.length && current.every((child, index) => child === children[index])) return;
  node.replaceChildren(...children);
}

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

export function formatRelativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at);
}

export function statusLabel(status: string, activity = ""): string {
  if (activity) return activity;
  const labels: Record<string, string> = {
    idle: "Ready",
    working: "Working",
    waiting: "Needs you",
    stopping: "Stopping",
    done: "Done",
    error: "Error",
    offline: "Offline",
    disabled: "Disabled",
  };
  return labels[status] ?? status;
}

export function modelLabel(model: { name: string } | undefined): string {
  return model?.name ?? "Unknown model";
}
