import assert from "node:assert/strict";
import test from "node:test";

import { downloadSlackImages, MAX_IMAGE_INPUT_BYTES } from "../src/daemon/images.js";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("image payload"),
]);

test("downloads authenticated Slack images and trusts detected content type", async () => {
  let authorization: string | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(png, { status: 200, headers: { "content-length": String(png.byteLength) } });
  }) as typeof fetch;

  const result = await downloadSlackImages(
    [
      {
        id: "F123",
        name: "screenshot.png",
        mimetype: "image/jpeg",
        size: png.byteLength,
        url_private_download: "https://files.slack.com/screenshot",
      },
    ],
    "xoxb-secret",
    fetchImpl,
  );

  assert.equal(authorization, "Bearer xoxb-secret");
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.images, [{ data: png.toString("base64"), mimeType: "image/png" }]);
});

test("rejects unsupported and oversized Slack files before download", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(png);
  }) as typeof fetch;

  const result = await downloadSlackImages(
    [
      { id: "F123", name: "notes.pdf", mimetype: "application/pdf", size: 100, url_private: "https://files.test/a" },
      {
        id: "F124",
        name: "huge.png",
        mimetype: "image/png",
        size: MAX_IMAGE_INPUT_BYTES + 1,
        url_private: "https://files.test/b",
      },
    ],
    "xoxb-secret",
    fetchImpl,
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.images.length, 0);
  assert.deepEqual(
    result.rejected.map(({ name }) => name),
    ["notes.pdf", "huge.png"],
  );
});

test("rejects non-Slack download URLs without forwarding the bot token", async () => {
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(png);
  }) as typeof fetch;

  const result = await downloadSlackImages(
    [{
      id: "F123",
      name: "stolen.png",
      mimetype: "image/png",
      size: png.byteLength,
      url_private: "https://slack.com.attacker.invalid/collect",
    }],
    "xoxb-secret",
    fetchImpl,
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.images.length, 0);
  assert.match(result.rejected[0]?.reason ?? "", /invalid download URL/);
});

test("rejects downloaded bytes that are not a supported image", async () => {
  const fetchImpl = (async () => new Response("not an image", { status: 200 })) as typeof fetch;

  const result = await downloadSlackImages(
    [{ id: "F123", name: "fake.png", mimetype: "image/png", size: 12, url_private: "https://files.slack.com/fake" }],
    "xoxb-secret",
    fetchImpl,
  );

  assert.equal(result.images.length, 0);
  assert.match(result.rejected[0]?.reason ?? "", /not a supported image/);
});
