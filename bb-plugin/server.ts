// bb-plugin-slackoff — backend entry.
//
// Mirrors opted-in BB threads into Slack DM threads over Socket Mode. The
// bridge (src/bridge.ts) does the work; this file wires settings, the Slack
// connection service, BB lifecycle events, RPC for the thread header control,
// and the `bb slackoff` CLI.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { SlackoffBridge, type BridgeSettings } from "./src/bridge.ts";
import { SlackApi } from "./src/slack/api.ts";
import { SocketModeClient } from "./src/slack/socket-mode.ts";
import { BindingStore } from "./src/store.ts";

export const CHANGED_CHANNEL = "slackoff-changed";

const ThreadStateSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  mirrored: z.boolean(),
  permalink: z.string().nullable(),
});
export type ThreadState = z.infer<typeof ThreadStateSchema>;

export const rpcContract = defineRpcContract({
  threadState: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: ThreadStateSchema,
  },
  setMirrored: {
    input: z.object({ threadId: z.string().min(1), enabled: z.boolean() }).strict(),
    output: ThreadStateSchema,
  },
});

const NOT_CONFIGURED =
  "Set the Slack tokens and your member ID: bb plugin config slackoff set botToken <xoxb-…>, appToken <xapp-…> and userId <U…>.";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    botToken: {
      type: "string",
      label: "Slack bot token",
      description: "The xoxb- token from your Slack app's OAuth page.",
      secret: true,
    },
    appToken: {
      type: "string",
      label: "Slack app-level token",
      description: "An xapp- token with the connections:write scope, for Socket Mode.",
      secret: true,
    },
    userId: {
      type: "string",
      label: "Your Slack member ID",
      description: "Only this Slack user can control threads. Find it in your Slack profile under ⋯ → Copy member ID.",
      default: "",
      experimental_schema: z.string().regex(/^$|^[UW][A-Z0-9]{2,}$/u, "A Slack member ID looks like U0123456789"),
    },
    defaultProjectId: {
      type: "project",
      label: "Project for threads started from Slack",
      description: "A direct message to the app starts a thread in this project. Without one, Slack asks you to choose.",
    },
    mirrorNewThreads: {
      type: "boolean",
      label: "Mirror new threads automatically",
      description: "Mirror every new visible top-level thread, not only the ones you turn on.",
      default: false,
    },
    showActivity: {
      type: "boolean",
      label: "Show tool activity",
      description: "Post a live progress card with the agent's commands, edits and plan for each turn.",
      default: true,
    },
    appUrl: {
      type: "string",
      label: "BB web address for links",
      description: "Optional. Adds an Open in BB link to each card. Without it, Show in BB focuses the thread in your open BB window.",
      default: "",
    },
  });

  let values = await settings.get();
  const configured = () => Boolean(values.botToken && values.appToken && values.userId);
  if (!configured()) bb.status.needsConfiguration(NOT_CONFIGURED);

  const bridgeSettings = async (): Promise<BridgeSettings> => ({
    userId: values.userId,
    defaultProjectId: typeof values.defaultProjectId === "string" && values.defaultProjectId ? values.defaultProjectId : undefined,
    mirrorNewThreads: values.mirrorNewThreads,
    showActivity: values.showActivity,
    appUrl: values.appUrl || bb.server.experimental_appUrl || undefined,
  });

  const store = new BindingStore(bb.storage.kv);
  let bridge: SlackoffBridge | undefined;
  let connected = false;
  let restart: AbortController | undefined;

  settings.onChange((next, previous) => {
    values = next;
    // New credentials need a new Slack connection.
    if (next.botToken !== previous.botToken || next.appToken !== previous.appToken || next.userId !== previous.userId) restart?.abort();
  });

  const publish = (threadId: string) => bb.realtime.publish(CHANGED_CHANNEL, { threadId });

  bb.background.service("slack", {
    async start(signal) {
      while (!signal.aborted) {
        if (!configured()) throw Object.assign(new Error(NOT_CONFIGURED), { name: "NeedsConfigurationError" });
        restart = new AbortController();
        const run = AbortSignal.any([signal, restart.signal]);
        const slack = new SlackApi({ token: String(values.botToken) });
        const app = new SlackApi({ token: String(values.appToken) });
        const current = new SlackoffBridge({
          pluginId: bb.pluginId,
          sdk: bb.sdk,
          slack,
          store,
          settings: bridgeSettings,
          log: bb.log,
          publish,
        });
        bridge = current;
        const socket = new SocketModeClient({
          openConnection: async () => {
            const result = await app.call<{ ok: boolean; url?: string }>("apps.connections.open");
            if (!result.url) throw new Error("Slack returned no Socket Mode URL");
            return result.url;
          },
          onEnvelope: (envelope) => current.handleEnvelope(envelope),
          log: bb.log,
          onConnectionChange: (up) => {
            if (up === connected) return;
            connected = up;
            bb.log.info(up ? "Connected to Slack" : "Disconnected from Slack");
            if (up) void current.reconcileAll().catch((error) => bb.log.error(`reconcile failed: ${String(error)}`));
            bb.realtime.publish(CHANGED_CHANNEL, { threadId: null });
          },
        });
        try {
          await socket.run(run);
        } finally {
          current.dispose();
          // Let queued Slack work finish so the next bridge never mirrors the same events.
          await current.idle();
          if (bridge === current) bridge = undefined;
          connected = false;
        }
      }
    },
  });

  // BB lifecycle → Slack. Handlers are fire-and-forget; the bridge serialises per thread.
  bb.events.on("experimental_thread.events", ({ thread }) => bridge?.onThreadEvents(thread));
  bb.events.on("thread.created", ({ thread }) => bridge?.onThreadCreated(thread));
  bb.events.on("thread.active", ({ thread }) => bridge?.onThreadStatus(thread, "active"));
  bb.events.on("thread.idle", ({ thread }) => bridge?.onThreadStatus(thread, "idle"));
  bb.events.on("thread.failed", ({ thread, error }) => bridge?.onThreadStatus(thread, "failed", error));
  bb.events.on("thread.archived", ({ thread }) => bridge?.onThreadStatus(thread, "archived"));
  bb.events.on("thread.unarchived", ({ thread }) => bridge?.onThreadStatus(thread, "unarchived"));
  bb.events.on("thread.deleted", ({ thread }) => bridge?.onThreadStatus(thread, "deleted"));
  bb.events.on("interaction.pending", ({ thread, interaction }) => bridge?.onInteraction(thread, interaction));

  const requireBridge = (): SlackoffBridge => {
    if (!configured()) throw new PluginCliError("Slackoff is not configured.", { code: "not_configured", hint: NOT_CONFIGURED });
    if (!bridge || !connected) {
      throw new PluginCliError("Slackoff is not connected to Slack yet.", {
        code: "not_connected",
        hint: "Check `bb plugin logs slackoff` for connection errors.",
      });
    }
    return bridge;
  };

  const threadState = async (threadId: string): Promise<ThreadState> => {
    if (!bridge) return { configured: configured(), connected, mirrored: (await store.get(threadId))?.enabled ?? false, permalink: null };
    const state = await bridge.status(threadId);
    return { configured: configured(), connected, mirrored: state.mirrored, permalink: state.permalink ?? null };
  };

  bb.rpc.register(rpcContract, {
    threadState: ({ threadId }) => threadState(threadId),
    async setMirrored({ threadId, enabled }) {
      const current = requireBridge();
      if (enabled) await current.enable(threadId);
      else await current.disable(threadId);
      return threadState(threadId);
    },
  });

  const threadOption = {
    thread: {
      type: "string" as const,
      aliases: ["thread-id", "id"],
      description: "BB thread ID. Defaults to the thread running the command.",
    },
  };
  const resolveThread = (option: string | undefined, ctx: { threadId?: string }): string => {
    const threadId = option ?? ctx.threadId;
    if (!threadId) {
      throw new PluginCliError("No thread given.", { code: "thread_required", hint: "Pass --thread <thr_…>, or run the command inside a BB thread." });
    }
    return threadId;
  };

  bb.cli.register(
    defineCli({
      name: "slackoff",
      summary: "Mirror BB threads into Slack DM threads",
      commands: {
        on: cliCommand({
          summary: "Start mirroring a thread to Slack",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThread(input.options.thread, ctx);
            await requireBridge().enable(threadId);
            const state = await threadState(threadId);
            return { exitCode: 0, stdout: `Mirroring ${threadId} to Slack${state.permalink ? `: ${state.permalink}` : "."}\n` };
          },
        }),
        off: cliCommand({
          summary: "Stop mirroring a thread to Slack",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThread(input.options.thread, ctx);
            await requireBridge().disable(threadId);
            return { exitCode: 0, stdout: `Stopped mirroring ${threadId}.\n` };
          },
        }),
        status: cliCommand({
          summary: "Show the Slack connection and a thread's mirror state",
          options: { ...threadOption, json: { type: "boolean" as const, description: "Print JSON" } },
          async run(input, ctx) {
            const threadId = input.options.thread ?? ctx.threadId;
            const state = threadId ? await threadState(threadId) : { configured: configured(), connected, mirrored: false, permalink: null };
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify({ threadId: threadId ?? null, ...state })}\n` };
            const lines = [
              `Slack: ${!state.configured ? "not configured" : state.connected ? "connected" : "connecting"}`,
              ...(threadId ? [`Thread ${threadId}: ${state.mirrored ? `mirrored${state.permalink ? ` (${state.permalink})` : ""}` : "not mirrored"}`] : []),
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        list: cliCommand({
          summary: "List mirrored threads",
          options: { json: { type: "boolean" as const, description: "Print JSON" } },
          async run(input) {
            const bindings = (await store.list()).filter((binding) => binding.enabled);
            if (input.options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(bindings.map(({ threadId, projectId, channelId, rootTs }) => ({ threadId, projectId, channelId, rootTs })))}\n` };
            }
            if (bindings.length === 0) return { exitCode: 0, stdout: "No threads are mirrored.\n" };
            return { exitCode: 0, stdout: `${bindings.map((binding) => binding.threadId).join("\n")}\n` };
          },
        }),
      },
    }),
  );
}
