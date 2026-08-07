import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const FileConfigSchema = z.object({
  userId: z.string().regex(/^U[A-Z0-9]+$/).optional(),
  botTokenFile: z.string().min(1).optional(),
  appTokenFile: z.string().min(1).optional(),
  socketPath: z.string().min(1).optional(),
  nodePath: z.string().min(1).optional(),
});

export interface ClientConfig {
  userId: string;
  socketPath: string;
  nodePath: string;
  configPath: string;
}

export interface DaemonConfig extends ClientConfig {
  botToken: string;
  appToken: string;
}

export function loadClientConfig(environment: NodeJS.ProcessEnv = process.env): ClientConfig {
  const configPath = environment.SLACKOFF_CONFIG ?? join(homedir(), ".config", "slackoff", "config.json");
  const fileConfig = existsSync(configPath)
    ? FileConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    : FileConfigSchema.parse({});
  const runtimeDirectory = environment.XDG_RUNTIME_DIR ?? `/tmp/slackoff-${process.getuid?.() ?? "user"}`;
  const userId = environment.SLACKOFF_USER_ID ?? fileConfig.userId;

  if (!userId) {
    throw new Error(`Slackoff user ID is missing. Set SLACKOFF_USER_ID or userId in ${configPath}`);
  }

  return {
    userId,
    socketPath: environment.SLACKOFF_SOCKET_PATH ?? fileConfig.socketPath ?? join(runtimeDirectory, "slackoff.sock"),
    nodePath: environment.SLACKOFF_NODE ?? fileConfig.nodePath ?? "node",
    configPath,
  };
}

export function loadDaemonConfig(environment: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const client = loadClientConfig(environment);
  const fileConfig = existsSync(client.configPath)
    ? FileConfigSchema.parse(JSON.parse(readFileSync(client.configPath, "utf8")))
    : FileConfigSchema.parse({});
  const runtimeDirectory = environment.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? "user"}`;
  const defaultSecretDirectory = join(runtimeDirectory, "secrets");
  const botToken = loadSecret(
    "SLACKOFF_BOT_TOKEN",
    environment,
    fileConfig.botTokenFile ?? join(defaultSecretDirectory, "SLACKOFF_BOT_TOKEN"),
  );
  const appToken = loadSecret(
    "SLACKOFF_APP_TOKEN",
    environment,
    fileConfig.appTokenFile ?? join(defaultSecretDirectory, "SLACKOFF_APP_TOKEN"),
  );

  if (!botToken.startsWith("xoxb-")) throw new Error("SLACKOFF_BOT_TOKEN is not a bot token");
  if (!appToken.startsWith("xapp-")) throw new Error("SLACKOFF_APP_TOKEN is not an app token");

  return { ...client, botToken, appToken };
}

function loadSecret(name: string, environment: NodeJS.ProcessEnv, defaultFile: string): string {
  const directValue = environment[name]?.trim();
  if (directValue) return directValue;

  const filePath = environment[`${name}_FILE`] ?? defaultFile;
  if (!existsSync(filePath)) {
    throw new Error(`${name} is missing. Set ${name}, ${name}_FILE, or configure its token file.`);
  }

  const value = readFileSync(filePath, "utf8").trim();
  if (!value) throw new Error(`${name} file is empty: ${filePath}`);
  return value;
}
