import assert from "node:assert/strict";
import test from "node:test";

import { parseSettings } from "../extension/src/settings.js";
import {
  createUserscriptPlatform,
  USERSCRIPT_SETTINGS_KEY,
} from "../extension/src/platform/userscript.js";
import type { SlackCredential } from "../extension/src/platform.js";
import { DEFAULT_SETTINGS } from "../extension/src/types.js";

/**
 * The userscript platform reaches every browser global through `globalThis`, so a plain Node test
 * can stand in for a page. No Tampermonkey grant is defined here, which exercises the degraded
 * localStorage and fetch paths that make the script runnable without a manager.
 */

const CREDENTIAL: SlackCredential = {
  teamId: "T0BNTEST01",
  teamName: "Chat Integrations Sandbox",
  token: "xoxc-secret",
  userId: "U080G7LQUUC",
  origin: "https://test.slack.com",
};

interface FetchInit {
  method: string;
  credentials: string;
  headers: Record<string, string>;
  body: string;
}

interface StubReply {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

interface Stub {
  calls: { url: string; init: FetchInit }[];
  storage: Map<string, string>;
  restore: () => void;
}

function stubPage(options: { origin?: string; reply?: StubReply; failFetch?: boolean } = {}): Stub {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = { location: globals.location, localStorage: globals.localStorage, fetch: globals.fetch };

  const calls: { url: string; init: FetchInit }[] = [];
  const storage = new Map<string, string>();

  globals.location = { origin: options.origin ?? CREDENTIAL.origin };
  globals.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  globals.fetch = (url: string, init: FetchInit) => {
    calls.push({ url, init });
    if (options.failFetch) return Promise.reject(new Error(`refused: ${init.body}`));
    const reply = options.reply ?? { status: 200, body: JSON.stringify({ ok: true }) };
    const headers = reply.headers ?? {};
    return Promise.resolve({
      status: reply.status,
      headers: {
        get: (name: string) =>
          Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ??
          null,
      },
      text: () => Promise.resolve(reply.body),
    });
  };

  return {
    calls,
    storage,
    restore: () => {
      globals.location = original.location;
      globals.localStorage = original.localStorage;
      globals.fetch = original.fetch;
    },
  };
}

test("userscript calls encode every parameter and keep the token out of the URL", async () => {
  const stub = stubPage({ reply: { status: 200, body: JSON.stringify({ ok: true, messages: [] }) } });
  try {
    const platform = createUserscriptPlatform();
    await platform.call(CREDENTIAL, "conversations.history", {
      channel: "D0BNVUT538S",
      text: "a&b=c\nd é",
      limit: 5,
      include_all_metadata: true,
    });

    const call = stub.calls[0];
    assert.ok(call, "expected one request");
    // Same origin as the page, so the request stays relative and no CORS preflight is possible.
    assert.equal(call.url, "/api/conversations.history");
    assert.equal(
      call.init.body,
      "channel=D0BNVUT538S&text=a%26b%3Dc%0Ad+%C3%A9&limit=5&include_all_metadata=true&token=xoxc-secret",
    );
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.headers["Content-Type"], "application/x-www-form-urlencoded; charset=utf-8");
    assert.ok(!call.url.includes(CREDENTIAL.token), "token must never appear in the URL");
  } finally {
    stub.restore();
  }
});

test("userscript call returns the parsed Slack payload", async () => {
  const stub = stubPage({ reply: { status: 200, body: JSON.stringify({ ok: true, channel: "D1", ts: "1.2" }) } });
  try {
    const result = await createUserscriptPlatform().call<{ channel: string; ts: string }>(
      CREDENTIAL,
      "chat.postMessage",
      { channel: "D1", text: "hi" },
    );
    assert.deepEqual(result, { ok: true, channel: "D1", ts: "1.2" });
  } finally {
    stub.restore();
  }
});

const rateLimitCases = [
  {
    name: "HTTP 429 uses the Retry-After header",
    reply: { status: 429, headers: { "Retry-After": "7" }, body: "" },
    error: "ratelimited",
    status: 429,
    retryAfterMs: 7000,
  },
  {
    name: "HTTP 429 without a header falls back",
    reply: { status: 429, body: "" },
    error: "ratelimited",
    status: 429,
    retryAfterMs: 30_000,
  },
  {
    name: "a ratelimited envelope on HTTP 200 still carries the delay",
    reply: { status: 200, headers: { "retry-after": "3" }, body: JSON.stringify({ ok: false, error: "ratelimited" }) },
    error: "ratelimited",
    status: 200,
    retryAfterMs: 3000,
  },
  {
    name: "an ordinary Slack error carries no delay",
    reply: { status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }) },
    error: "invalid_auth",
    status: 200,
    retryAfterMs: undefined,
  },
  {
    name: "an unparseable body is reported as such",
    reply: { status: 200, body: "<html>maintenance</html>" },
    error: "invalid_response",
    status: 200,
    retryAfterMs: undefined,
  },
] as const;

for (const testCase of rateLimitCases) {
  test(`userscript call rejects: ${testCase.name}`, async () => {
    const stub = stubPage({ reply: testCase.reply });
    try {
      const thrown = await createUserscriptPlatform()
        .call(CREDENTIAL, "conversations.history", { channel: "D1" })
        .then(
          () => undefined,
          (error: unknown) => error as Error & { status?: number; retryAfterMs?: number },
        );

      assert.ok(thrown, "expected a rejection");
      assert.equal(thrown.message, testCase.error);
      assert.equal(thrown.status, testCase.status);
      assert.equal(thrown.retryAfterMs, testCase.retryAfterMs);
    } finally {
      stub.restore();
    }
  });
}

test("a blocked cross-origin call names the missing @connect grant", async () => {
  const stub = stubPage({ origin: "https://app.slack.com", failFetch: true });
  try {
    const thrown = await createUserscriptPlatform()
      .call(CREDENTIAL, "auth.test", {})
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    assert.ok(thrown, "expected a rejection");
    assert.match(thrown.message, /@connect test\.slack\.com/);
    // The underlying failure quotes the request body, so the token must not reach the message.
    assert.ok(!thrown.message.includes(CREDENTIAL.token), "token must never reach an error message");
  } finally {
    stub.restore();
  }
});

test("settings round-trip through the localStorage fallback", async () => {
  const stub = stubPage();
  try {
    const platform = createUserscriptPlatform();
    assert.deepEqual(await platform.getSettings(), DEFAULT_SETTINGS);

    await platform.setSettings({ takeover: false, channelId: "D0BNVUT538S", theme: "slack" });

    const raw = stub.storage.get(USERSCRIPT_SETTINGS_KEY);
    assert.ok(raw, "settings must be stored under the single documented key");
    assert.deepEqual(JSON.parse(raw), {
      notifications: true,
      takeover: false,
      theme: "slack",
      channelId: "D0BNVUT538S",
    });

    // A fresh platform reads the same store, which is what a page reload does.
    assert.deepEqual(await createUserscriptPlatform().getSettings(), {
      notifications: true,
      takeover: false,
      theme: "slack",
      channelId: "D0BNVUT538S",
    });

    // Patches merge rather than replace.
    await platform.setSettings({ takeover: true });
    assert.equal((await platform.getSettings()).channelId, "D0BNVUT538S");

    // An empty string is how the cached channel is cleared where there is no delete primitive.
    await platform.setSettings({ channelId: "" });
    assert.equal((await platform.getSettings()).channelId, undefined);
    assert.equal((await platform.getSettings()).theme, "slack");
  } finally {
    stub.restore();
  }
});

test("settings listeners see the new value and stop after unsubscribe", async () => {
  const stub = stubPage();
  try {
    const platform = createUserscriptPlatform();
    const seen: boolean[] = [];
    const unsubscribe = platform.onSettingsChanged((settings) => seen.push(settings.takeover));

    await platform.setSettings({ takeover: false });
    await platform.setSettings({ takeover: true });
    unsubscribe();
    await platform.setSettings({ takeover: false });

    assert.deepEqual(seen, [false, true]);
  } finally {
    stub.restore();
  }
});

const paritySnapshots = [
  { name: "empty store", stored: {} },
  { name: "fully populated", stored: { origin: "https://test.slack.com", channelId: "D1", userId: "U1", notifications: false, takeover: false, theme: "slack" } },
  { name: "empty strings read as absent", stored: { channelId: "", origin: "", userId: "" } },
  { name: "one corrupt key does not reset the rest", stored: { notifications: "yes", takeover: false, theme: "codex" } },
  { name: "unknown keys are ignored", stored: { theme: "codex", somethingElse: 42 } },
  { name: "an unknown theme falls back", stored: { theme: "neon", takeover: false } },
] as const;

for (const snapshot of paritySnapshots) {
  test(`both platforms read settings identically: ${snapshot.name}`, async () => {
    const stub = stubPage();
    try {
      // The extension platform hands chrome.storage's snapshot straight to parseSettings, so that
      // call is exactly what it would produce for this store.
      const viaExtension = parseSettings(snapshot.stored);
      stub.storage.set(USERSCRIPT_SETTINGS_KEY, JSON.stringify(snapshot.stored));
      const viaUserscript = await createUserscriptPlatform().getSettings();

      assert.deepEqual(viaUserscript, viaExtension);
    } finally {
      stub.restore();
    }
  });
}

test("a corrupt settings blob falls back to the defaults", async () => {
  const stub = stubPage();
  try {
    stub.storage.set(USERSCRIPT_SETTINGS_KEY, "{not json");
    assert.deepEqual(await createUserscriptPlatform().getSettings(), DEFAULT_SETTINGS);
  } finally {
    stub.restore();
  }
});

test("badge and notify are inert without a toolbar or a granted permission", () => {
  const stub = stubPage();
  try {
    const platform = createUserscriptPlatform();
    // Neither may throw, and notify must never prompt for permission on its own.
    platform.setBadge(4);
    platform.notify("sess-1", "Session waiting", "Waiting for you");
    platform.registerCommand("Toggle takeover", () => undefined);
  } finally {
    stub.restore();
  }
});
