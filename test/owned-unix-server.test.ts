import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OwnedUnixServer } from "../src/daemon/owned-unix-server.js";

const rejectConnection = (socket: Socket): void => {
  socket.destroy();
};

test("holds the daemon lease after the IPC socket path is removed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slackoff-owner-"));
  const socketPath = join(directory, "slackoff.sock");
  const first = new OwnedUnixServer(socketPath);
  const second = new OwnedUnixServer(socketPath);

  try {
    await first.listen(rejectConnection);
    unlinkSync(socketPath);

    await assert.rejects(second.listen(rejectConnection), /Slackoff daemon is already running/);
  } finally {
    await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not unlink a replacement owned by another server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slackoff-owner-"));
  const socketPath = join(directory, "slackoff.sock");
  const original = new OwnedUnixServer(socketPath);
  const replacement = createServer(rejectConnection);

  try {
    await original.listen(rejectConnection);
    unlinkSync(socketPath);
    replacement.listen(socketPath);
    await once(replacement, "listening");

    await original.close();

    assert.equal(existsSync(socketPath), true);
    await assert.doesNotReject(connectOnce(socketPath));
  } finally {
    await closeServer(replacement);
    await original.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function connectOnce(socketPath: string): Promise<void> {
  const socket = connect(socketPath);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.once("connect", () => {
    socket.destroy();
    resolve();
  });
  socket.once("error", reject);
  return promise;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}
