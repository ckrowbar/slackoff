import assert from "node:assert/strict";
import test from "node:test";

import type { Platform, SlackCredential, SlackParams } from "../extension/src/platform.js";
import { uploadSlackImages } from "../extension/src/slack/api.js";
import { DEFAULT_SETTINGS } from "../extension/src/types.js";

const CREDENTIAL: SlackCredential = {
  teamId: "T1",
  teamName: "Test",
  token: "xoxc-secret",
  origin: "https://test.slack.com",
};

function harness(): {
  platform: Platform;
  calls: Array<{ method: string; params: SlackParams }>;
  uploads: Array<{ url: string; bytes: Uint8Array; contentType: string }>;
} {
  const calls: Array<{ method: string; params: SlackParams }> = [];
  const uploads: Array<{ url: string; bytes: Uint8Array; contentType: string }> = [];
  let reservation = 0;
  const platform: Platform = {
    async call<T>(_credential: SlackCredential, method: string, params: SlackParams): Promise<T> {
      calls.push({ method, params });
      if (method === "files.getUploadURLExternal") {
        reservation += 1;
        return {
          ok: true,
          upload_url: `https://files.slack.com/upload/${reservation}`,
          file_id: `F${reservation}`,
        } as T;
      }
      return { ok: true } as T;
    },
    async upload(url, bytes, contentType) {
      uploads.push({ url, bytes: new Uint8Array(bytes), contentType });
    },
    async getSettings() { return DEFAULT_SETTINGS; },
    async setSettings() {},
    onSettingsChanged() { return () => undefined; },
    notify() {},
    setBadge() {},
    registerCommand() {},
  };
  return { platform, calls, uploads };
}

test("image upload reserves, transfers, and completes one Slack batch", async () => {
  const h = harness();
  await uploadSlackImages(h.platform, CREDENTIAL, {
    channelId: "D1",
    threadTs: "1.2",
    text: "Inspect these",
    images: [
      { name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1, 2]).buffer },
      { name: "b.webp", mimeType: "image/webp", bytes: new Uint8Array([3]).buffer },
    ],
  });

  assert.deepEqual(h.calls.map(({ method }) => method), [
    "files.getUploadURLExternal",
    "files.getUploadURLExternal",
    "files.completeUploadExternal",
  ]);
  assert.deepEqual(h.uploads, [
    { url: "https://files.slack.com/upload/1", bytes: new Uint8Array([1, 2]), contentType: "image/png" },
    { url: "https://files.slack.com/upload/2", bytes: new Uint8Array([3]), contentType: "image/webp" },
  ]);
  assert.deepEqual(h.calls.at(-1)?.params, {
    files: JSON.stringify([{ id: "F1", title: "a.png" }, { id: "F2", title: "b.webp" }]),
    channel_id: "D1",
    thread_ts: "1.2",
    initial_comment: "Inspect these",
  });
});
