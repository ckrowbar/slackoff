// bb-plugin-slackoff — frontend entry.
//
// One control in the thread header: shows whether the thread is mirrored to
// Slack and toggles it. The server publishes CHANGED_CHANNEL whenever mirror
// state or the Slack connection changes, so every open header stays current.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadState } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHANGED_CHANNEL = "slackoff-changed";

function SlackMirrorToggle({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ThreadState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("threadState", { threadId }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId]);

  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, (payload) => {
    const changed = (payload as { threadId?: string | null } | null)?.threadId;
    if (changed === undefined || changed === null || changed === threadId) refetch();
  });

  if (state === null || !state.configured) return null;

  const toggle = async () => {
    setPending(true);
    try {
      setState(await rpc.call("setMirrored", { threadId, enabled: !state.mirrored }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const label = !state.connected
    ? "Slackoff is connecting to Slack"
    : state.mirrored
      ? "Mirrored to Slack. Click to stop mirroring."
      : "Mirror this thread to Slack";

  return (
    <span title={error ?? label} className="inline-flex">
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7", state.mirrored ? "text-primary" : "text-muted-foreground hover:text-foreground")}
        aria-label={label}
        aria-pressed={state.mirrored}
        disabled={pending || !state.connected}
        onClick={() => void toggle()}
      >
        <Icon name={state.mirrored ? "MessageSquare" : "MessageSquarePlus"} className="size-4" />
      </Button>
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "slack-mirror",
    title: "Slack mirror",
    component: ({ threadId }) => <SlackMirrorToggle threadId={threadId} />,
  });
});
