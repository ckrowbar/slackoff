/** Reverse Slack's mrkdwn entity escaping. Decode `&amp;` last so `&amp;lt;` remains literal. */
export function unescapeMrkdwn(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Flatten the `<target|label>` syntax Slack stores after auto-linking user text. */
export function flattenSlackLinks(text: string): string {
  return text.replace(/<([^<>]*)>/g, (_match, body: string) => {
    const pipe = body.indexOf("|");
    if (pipe !== -1) return body.slice(pipe + 1) || body.slice(0, pipe);
    // Broadcasts read naturally as @here/@channel; bare user and channel mentions retain their IDs.
    return body.startsWith("!") ? `@${body.slice(1)}` : body;
  });
}
