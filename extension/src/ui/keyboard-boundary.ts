export function containKeyboardEvents(root: HTMLElement): () => void {
  const eventRoot = root.getRootNode();
  const stopPropagation = (event: Event): void => event.stopPropagation();
  eventRoot.addEventListener("keydown", stopPropagation);
  eventRoot.addEventListener("keyup", stopPropagation);
  return () => {
    eventRoot.removeEventListener("keydown", stopPropagation);
    eventRoot.removeEventListener("keyup", stopPropagation);
  };
}
