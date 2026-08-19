import assert from "node:assert/strict";
import test from "node:test";

import { startInstallerServer } from "../src/userscript-installer.js";

const userscript = `// ==UserScript==
// @name Slackoff Console
// ==/UserScript==`;

test("serves a one-click installer page and userscript", async () => {
  const installer = await startInstallerServer({
    build: async () => ({ commit: "abc123", source: userscript, trackingRef: "origin/main" }),
    port: 0,
    trackingRef: 'origin/<latest>"',
  });

  try {
    const page = await fetch(installer.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.match(html, /href="\/slackoff-console\.user\.js"/);
    assert.match(html, /origin\/&lt;latest&gt;&quot;/);

    const script = await fetch(`${installer.url}/slackoff-console.user.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("cache-control"), "no-store");
    assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(script.headers.get("x-slackoff-commit"), "abc123");
    assert.equal(await script.text(), userscript);
  } finally {
    await installer.close();
  }
});


test("rejects non-GET requests and unknown routes without building", async () => {
  let builds = 0;
  const installer = await startInstallerServer({
    build: async () => {
      builds += 1;
      return { commit: "abc123", source: userscript, trackingRef: "origin/main" };
    },
    port: 0,
    trackingRef: "origin/main",
  });

  try {
    const post = await fetch(`${installer.url}/slackoff-console.user.js`, { method: "POST" });
    const missing = await fetch(`${installer.url}/missing`);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.equal(missing.status, 404);
    assert.equal(builds, 0);
  } finally {
    await installer.close();
  }
});
