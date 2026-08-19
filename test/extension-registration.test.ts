import assert from "node:assert/strict";
import test from "node:test";

import { maintainSlackoffRegistration } from "../src/extension.js";

test("registration maintenance survives an initial failure and retries until registered", async () => {
  let registered = false;
  let attempts = 0;
  let heartbeats = 0;
  const errors: string[] = [];
  const maintain = () =>
    maintainSlackoffRegistration({
      enabled: true,
      registered,
      activate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("protocol mismatch");
        registered = true;
      },
      onRegistered: () => {
        heartbeats += 1;
      },
      onError: (error) => errors.push(error.message),
    });

  await maintain();
  assert.equal(registered, false);
  assert.deepEqual(errors, ["protocol mismatch"]);

  await maintain();
  assert.equal(registered, true);
  assert.equal(attempts, 2);

  await maintain();
  assert.equal(attempts, 2);
  assert.equal(heartbeats, 1);
});

test("registration maintenance stays inert while Slackoff is disabled", async () => {
  let attempts = 0;
  const result = maintainSlackoffRegistration({
    enabled: false,
    registered: false,
    activate: async () => {
      attempts += 1;
    },
    onRegistered: () => assert.fail("disabled maintenance sent a heartbeat"),
    onError: () => assert.fail("disabled maintenance reported an error"),
  });

  await result;
  assert.equal(attempts, 0);
});
