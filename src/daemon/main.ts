#!/usr/bin/env node

import { loadDaemonConfig } from "../config.js";
import { SlackoffDaemon } from "./server.js";

const daemon = new SlackoffDaemon(loadDaemonConfig());
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Slackoff daemon stopping after ${signal}`);
  await daemon.stop();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await daemon.start();
console.info("Slackoff daemon connected");
