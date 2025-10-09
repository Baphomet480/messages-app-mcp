import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger, __resetLoggerForTests } from "../../src/utils/logger.js";

async function createTempLogDir() {
  return mkdtemp(join(tmpdir(), "logger-spec-"));
}

async function waitForFile(path: string, timeoutMs = 500): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForStat(path: string, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("rotating file logger", () => {
  let originalEnv: string | undefined;
  let tempDir: string | null = null;

  beforeEach(() => {
    originalEnv = process.env.MESSAGES_MCP_LOG_DIR;
  });

  afterEach(async () => {
    if (tempDir) {
      const deadline = Date.now() + 500;
      // Retry removal if macOS reports ENOTEMPTY while async writes complete.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await rm(tempDir, { recursive: true, force: true });
          break;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === "ENOENT") break;
          if (err.code !== "ENOTEMPTY" || Date.now() >= deadline) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      tempDir = null;
    }
    process.env.MESSAGES_MCP_LOG_DIR = originalEnv;
    __resetLoggerForTests();
  });

  it("writes log entries to the configured directory", async () => {
    tempDir = await createTempLogDir();
    process.env.MESSAGES_MCP_LOG_DIR = tempDir;
    __resetLoggerForTests();

    const logger = getLogger({ consolePassThrough: false, logDir: tempDir });
    logger.info("test entry", { id: 1 });

    const logPath = join(tempDir, "messages-app-mcp.log");
    const content = await waitForFile(logPath);
    expect(content).toMatch(/test entry/);
    expect(content).toMatch(/"id":1/);
  });

  it("rotates the log file when maxBytes is exceeded", async () => {
    tempDir = await createTempLogDir();
    process.env.MESSAGES_MCP_LOG_DIR = tempDir;
    __resetLoggerForTests();

    const logger = getLogger({ consolePassThrough: false, maxBytes: 64, maxFiles: 2, logDir: tempDir });
    for (let i = 0; i < 20; i += 1) {
      logger.info("entry", "#".repeat(32), i);
    }

    const rotatedPath = join(tempDir, "messages-app-mcp.log.1");
    await expect(waitForStat(rotatedPath)).resolves.toBeDefined();
  });
});
