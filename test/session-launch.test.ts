import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeSessionLaunchRequest,
  parseSessionLaunchRequest,
  SESSION_LAUNCH_REQUEST_PREFIX,
} from "../src/session-launch.js";

test("session launch requests round-trip required and optional fields", () => {
  const request = { name: "review-api", cwd: "~/src/api", prompt: "Review the migration" };
  assert.deepEqual(parseSessionLaunchRequest(encodeSessionLaunchRequest(request)), request);
  const minimal = { name: "google-chat-meeting-summaries", cwd: "~/" };
  assert.deepEqual(parseSessionLaunchRequest(encodeSessionLaunchRequest(minimal)), minimal);
});

test("session launch parser recovers URLs reformatted by Slack", () => {
  const message =
    `${SESSION_LAUNCH_REQUEST_PREFIX}{"name":"want-to-deploy","cwd":"~","prompt":"Review <https://example.com/change%22}|https://example.com/change"}>`;
  assert.deepEqual(parseSessionLaunchRequest(message), {
    name: "want-to-deploy",
    cwd: "~",
    prompt: "Review https://example.com/change",
  });
});

test("session launch parser distinguishes ordinary messages from malformed requests", () => {
  assert.equal(parseSessionLaunchRequest("ordinary message"), undefined);
  assert.throws(
    () => parseSessionLaunchRequest(`${SESSION_LAUNCH_REQUEST_PREFIX}{broken`),
    /Invalid Slackoff launch request/,
  );
  assert.throws(
    () =>
      parseSessionLaunchRequest(
        `${SESSION_LAUNCH_REQUEST_PREFIX}${JSON.stringify({ name: "valid", cwd: "/tmp", prompt: "x".repeat(3_001) })}`,
      ),
    /Invalid Slackoff launch request/,
  );
});
