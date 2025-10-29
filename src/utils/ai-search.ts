import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getLogger } from "./logger.js";

const logger = getLogger();

const DEFAULT_MAX_DAYS = 365;
const DEFAULT_MAX_LIMIT = 50;

const helperState = {
  resolved: false as boolean,
  command: null as HelperCommand | null,
};

type HelperCommand = {
  executable: string;
  args: string[];
  type: "swift-script" | "executable";
};

export type SearchIntentContext = {
  defaultDays: number;
  defaultLimit: number;
};

export type SearchIntentRefinement = {
  query?: string;
  participant?: string;
  chat_guid?: string;
  days_back?: number;
  limit?: number;
  confidence?: number;
  source?: string;
};

type HelperRequest = {
  query: string;
  context: {
    defaultDays: number;
    maxDays: number;
    defaultLimit: number;
    maxLimit: number;
  };
  metadata?: Record<string, unknown>;
};

type HelperResponse = {
  result?: SearchIntentRefinement;
  error?: string;
};

const DEFAULT_RELATIVE_SCRIPT = "../../scripts/ai-search.swift";
const SWIFT_EXECUTABLE = process.env.MESSAGES_MCP_SWIFT_BIN?.trim() || "swift";

export async function refineSearchIntent(
  query: string,
  context: SearchIntentContext,
): Promise<SearchIntentRefinement | null> {
  if (!query.trim()) {
    return null;
  }
  const helper = await resolveHelper();
  if (!helper) {
    return null;
  }
  const request: HelperRequest = {
    query,
    context: {
      defaultDays: context.defaultDays,
      maxDays: DEFAULT_MAX_DAYS,
      defaultLimit: context.defaultLimit,
      maxLimit: DEFAULT_MAX_LIMIT,
    },
  };
  const child = spawn(helper.executable, helper.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  child.stdin.write(JSON.stringify(request));
  child.stdin.end();

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 0));
  });

  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (exitCode !== 0) {
    if (stderr) {
      logger.warn("AI search helper failed", { stderr, exitCode });
    }
    if (exitCode === 127 || exitCode === 126) {
      disableHelper();
    }
    return null;
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  if (!stdout) {
    return null;
  }
  try {
    const payload = JSON.parse(stdout) as HelperResponse;
    if (payload.error) {
      logger.debug("AI search helper returned error", { error: payload.error });
      return null;
    }
    if (payload.result) {
      return payload.result;
    }
  } catch (error) {
    logger.warn("Failed to parse AI search helper output", {
      stdout,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

async function resolveHelper(): Promise<HelperCommand | null> {
  if (helperState.resolved) {
    return helperState.command;
  }
  helperState.resolved = true;

  const explicitPath = process.env.MESSAGES_MCP_AI_SEARCH_SCRIPT?.trim();
  const defaultScript = resolveDefaultScript();
  const candidate = explicitPath || defaultScript;

  if (!candidate) {
    helperState.command = null;
    return null;
  }

  try {
    await access(candidate, constants.X_OK);
  } catch (error) {
    logger.debug("AI search helper not accessible", {
      path: candidate,
      error: error instanceof Error ? error.message : String(error),
    });
    helperState.command = null;
    return null;
  }

  const isSwiftScript = candidate.endsWith(".swift");
  const command: HelperCommand = isSwiftScript
    ? {
        executable: SWIFT_EXECUTABLE,
        args: [candidate],
        type: "swift-script",
      }
    : {
        executable: candidate,
        args: [],
        type: "executable",
      };
  helperState.command = command;
  return command;
}

function disableHelper() {
  helperState.resolved = true;
  helperState.command = null;
}

function resolveDefaultScript(): string | null {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const scriptPath = path.resolve(moduleDir, DEFAULT_RELATIVE_SCRIPT);
  return scriptPath;
}
