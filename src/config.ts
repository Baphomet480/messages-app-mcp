import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_CONFIG_BASENAME = "messages-mcp.config.json";
const ENV_CONFIG_PATH = "MESSAGES_MCP_CONFIG";

export type TransportMode = "stdio" | "http";

export type CodeExecWrappersConfig = {
  outputDir?: string;
  serverCommand?: string;
  serverArgs?: string[];
  env?: Record<string, string>;
};

export type MessagesConfig = {
  transport: TransportMode;
  http?: {
    port?: number;
    host?: string;
    enableSseFallback?: boolean;
    corsOrigins?: string[];
    dnsRebindingProtection?: boolean;
    allowedHosts?: string[];
  };
  logViewer?: {
    enabled?: boolean;
    autoOpen?: boolean;
    pollIntervalMs?: number;
    port?: number;
  };
  codeExecWrappers?: CodeExecWrappersConfig;
};

const defaultConfig: MessagesConfig = {
  transport: "stdio",
  logViewer: {
    enabled: true,
    autoOpen: true,
    pollIntervalMs: undefined,
    port: undefined,
  },
  codeExecWrappers: {
    outputDir: "src/agents/messages/generated",
    serverArgs: ["dist/index.js", "--stdio"],
    env: {
      MESSAGES_MCP_LOG_VIEWER: "0",
      MESSAGES_MCP_LOG_VIEWER_AUTO_OPEN: "0",
    },
  },
};

async function readConfigFile(path: string): Promise<Partial<MessagesConfig> | null> {
  try {
    const data = await readFile(path, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function resolveConfigPath(): string | null {
  const envPath = process.env[ENV_CONFIG_PATH];
  if (envPath && envPath.trim().length > 0) {
    return resolve(envPath.trim());
  }

  const cwdCandidate = resolve(DEFAULT_CONFIG_BASENAME);
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const homeCandidate = join(homedir(), ".config", DEFAULT_CONFIG_BASENAME);
  if (existsSync(homeCandidate)) {
    return homeCandidate;
  }

  return null;
}

function mergeConfigs(base: MessagesConfig, override: Partial<MessagesConfig> | null | undefined): MessagesConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    http: {
      ...base.http,
      ...override.http,
    },
    logViewer: {
      ...base.logViewer,
      ...override.logViewer,
    },
    codeExecWrappers: {
      ...base.codeExecWrappers,
      ...override.codeExecWrappers,
    },
  } satisfies MessagesConfig;
}

export async function loadMessagesConfig(): Promise<MessagesConfig> {
  const path = resolveConfigPath();
  if (!path) {
    return mergeConfigs(defaultConfig, null);
  }
  const fileConfig = await readConfigFile(path);
  return mergeConfigs(defaultConfig, fileConfig);
}
