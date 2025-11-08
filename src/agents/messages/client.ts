import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { name?: string; version?: string };

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "../../..");
const DEFAULT_SERVER_ENTRY = join(PROJECT_ROOT, "dist/index.js");

export type MessagesClientOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientInfo?: Partial<Implementation>;
};

export type MessagesClientHandle = {
  client: Client;
  close: () => Promise<void>;
};

function resolveDefaultCommand(customCommand?: string): string {
  if (customCommand && customCommand.trim().length > 0) {
    return customCommand;
  }
  return process.execPath;
}

function resolveDefaultArgs(customArgs?: string[]): string[] {
  if (customArgs && customArgs.length > 0) {
    return customArgs;
  }
  if (!existsSync(DEFAULT_SERVER_ENTRY)) {
    throw new Error(
      `messages-app-mcp dist build missing at ${DEFAULT_SERVER_ENTRY}. Run "pnpm build" before creating a code-exec client.`
    );
  }
  return [DEFAULT_SERVER_ENTRY, "--stdio"];
}

function resolveClientInfo(overrides?: Partial<Implementation>): Implementation {
  const fallbackName = typeof pkg?.name === "string" && pkg.name.trim().length > 0 ? pkg.name : "messages-app-mcp";
  const fallbackVersion = typeof pkg?.version === "string" && pkg.version.trim().length > 0 ? pkg.version : "0.0.0";
  return {
    name: overrides?.name?.trim().length ? overrides.name : `${fallbackName}-code-client`,
    version: overrides?.version?.trim().length ? overrides.version : fallbackVersion,
  } satisfies Implementation;
}

export async function createMessagesClient(options: MessagesClientOptions = {}): Promise<MessagesClientHandle> {
  const command = resolveDefaultCommand(options.command);
  const args = resolveDefaultArgs(options.args);
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env,
    stderr: "inherit",
  });
  await transport.start();
  const client = new Client(resolveClientInfo(options.clientInfo));
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.close();
    },
  };
}
