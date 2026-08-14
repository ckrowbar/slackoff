import { isTextField } from "./dom.js";

export interface KeyActions {
  paletteOpen(): boolean;
  handlePaletteKey(event: KeyboardEvent): boolean;
  togglePalette(): void;
  moveSelection(delta: number): void;
  focusComposer(): void;
  composerFocused(): boolean;
  blurComposer(): void;
  offerStop(): void;
  chooseQuestionOption(index: number): boolean;
  jumpToAttention(): void;
  toggleShortcuts(): void;
}

export function installKeys(root: HTMLElement, actions: KeyActions): () => void {
  const eventRoot = root.getRootNode();
  let awaitingGroup = false;
  let groupTimer: number | undefined;

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      actions.togglePalette();
      return;
    }
    if (actions.paletteOpen() && actions.handlePaletteKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const inTextField = isTextField(event.target);
    if (event.key === "Escape" && actions.composerFocused()) {
      event.preventDefault();
      actions.blurComposer();
      return;
    }
    if (inTextField || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      event.preventDefault();
      actions.offerStop();
      return;
    }
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      actions.moveSelection(1);
      return;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      actions.moveSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      actions.focusComposer();
      return;
    }
    if (/^[1-9]$/.test(event.key) && actions.chooseQuestionOption(Number(event.key) - 1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "?") {
      event.preventDefault();
      actions.toggleShortcuts();
      return;
    }
    if (awaitingGroup) {
      awaitingGroup = false;
      if (groupTimer !== undefined) window.clearTimeout(groupTimer);
      groupTimer = undefined;
      if (event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        actions.jumpToAttention();
      }
      return;
    }
    if (event.key.toLocaleLowerCase() === "g") {
      awaitingGroup = true;
      groupTimer = window.setTimeout(() => {
        awaitingGroup = false;
        groupTimer = undefined;
      }, 700);
    }
  };

  eventRoot.addEventListener("keydown", onKeyDown);
  return () => {
    eventRoot.removeEventListener("keydown", onKeyDown);
    if (groupTimer !== undefined) window.clearTimeout(groupTimer);
  };
}
