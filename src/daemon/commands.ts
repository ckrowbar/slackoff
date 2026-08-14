/**
 * Thread control commands.
 *
 * A reader that can only post thread messages (the Chrome extension) cannot click a Block Kit
 * button, so the same controls are reachable as exact single-line message texts. Anything that
 * is not an exact command stays an instruction or a question answer, which is why the grammar is
 * deliberately unforgiving: single line, one leading `!`, no trailing prose.
 */
export type ThreadCommand =
  | { kind: "stop" }
  | { kind: "close" }
  | { kind: "model"; selector: string }
  | { kind: "omp"; command: string };

const MODEL_SELECTOR = /^[A-Za-z0-9][\w.-]*\/[\w.:-]+$/;

export function parseThreadCommand(text: string): ThreadCommand | undefined {
  const line = text.trim();
  if (!line.startsWith("!") || /[\r\n]/.test(line)) return undefined;

  const [keyword = "", ...args] = line.slice(1).split(/\s+/);
  switch (keyword.toLowerCase()) {
    case "stop":
      return args.length === 0 ? { kind: "stop" } : undefined;
    case "close":
      return args.length === 0 ? { kind: "close" } : undefined;
    case "model": {
      const selector = args.length === 1 ? args[0] : undefined;
      if (!selector || !MODEL_SELECTOR.test(selector)) return undefined;
      return { kind: "model", selector };
    }
    case "omp": {
      const commandName = args[0];
      if (!commandName || commandName.startsWith("/")) return undefined;
      return { kind: "omp", command: `/${args.join(" ")}` };
    }
    default:
      return undefined;
  }
}
