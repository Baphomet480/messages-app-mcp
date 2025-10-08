import { mkdir, appendFile, stat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LoggerOptions {
  logDir?: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  consolePassThrough?: boolean;
}

const DEFAULT_FILE_NAME = "messages-app-mcp.log";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_MAX_FILES = 5;

const defaultOptions: Required<LoggerOptions> = {
  logDir: getDefaultLogDirectory(),
  fileName: DEFAULT_FILE_NAME,
  maxBytes: Number.parseInt(process.env.MESSAGES_MCP_LOG_MAX_BYTES ?? "", 10) || DEFAULT_MAX_BYTES,
  maxFiles: Number.parseInt(process.env.MESSAGES_MCP_LOG_MAX_FILES ?? "", 10) || DEFAULT_MAX_FILES,
  consolePassThrough: true,
};

function getDefaultLogDirectory(): string {
  const envDir = process.env.MESSAGES_MCP_LOG_DIR;
  if (envDir && envDir.trim().length > 0) {
    return envDir;
  }
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Logs", "messages-app-mcp");
  }
  return join(home, ".messages-app-mcp", "logs");
}

function formatLogLine(level: LogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const rendered = args.map(renderArgument).join(" ");
  return `${timestamp} [${level}] ${rendered}`.trimEnd() + "\n";
}

function renderArgument(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class RotatingFileLogger {
  private readonly filePath: string;
  private readonly options: Required<LoggerOptions>;
  private queue: Promise<void> = Promise.resolve();
  private initialised = false;

  constructor(options: LoggerOptions = {}) {
    this.options = { ...defaultOptions, ...options };
    this.filePath = join(this.options.logDir, this.options.fileName);
  }

  info(...args: unknown[]): void {
    this.write("INFO", args);
  }

  warn(...args: unknown[]): void {
    this.write("WARN", args);
  }

  error(...args: unknown[]): void {
    this.write("ERROR", args);
  }

  debug(...args: unknown[]): void {
    this.write("DEBUG", args);
  }

  private write(level: LogLevel, args: unknown[]): void {
    const line = formatLogLine(level, args);
    if (this.options.consolePassThrough) {
      this.emitToConsole(level, args);
    }
    this.queue = this.queue.then(async () => {
      await this.ensureReady();
      await appendFile(this.filePath, line, { encoding: "utf8" });
      await this.rotateIfNeeded();
    }).catch((err) => {
      if (this.options.consolePassThrough) {
        this.emitToConsole("ERROR", ["Logger failure: ", err]);
      }
    });
  }

  private emitToConsole(level: LogLevel, args: unknown[]): void {
    switch (level) {
      case "ERROR":
        console.error(...args);
        break;
      case "WARN":
        console.warn(...args);
        break;
      default:
        console.log(...args);
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.initialised) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "", { flag: "a" });
    this.initialised = true;
  }

  private async rotateIfNeeded(): Promise<void> {
    const { maxBytes, maxFiles } = this.options;
    if (maxFiles <= 1) return;
    const stats = await stat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats || stats.size <= maxBytes) {
      return;
    }
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      const dest = `${this.filePath}.${index + 1}`;
      await rm(dest, { force: true }).catch(() => {});
      await rename(source, dest).catch((error: NodeJS.ErrnoException) => {
        if (error && error.code === "ENOENT") {
          return;
        }
        throw error;
      });
    }
    await rm(`${this.filePath}.1`, { force: true }).catch(() => {});
    await rename(this.filePath, `${this.filePath}.1`).catch((error: NodeJS.ErrnoException) => {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    });
    await writeFile(this.filePath, "", { flag: "w" });
  }
}

let sharedLogger: RotatingFileLogger | undefined;

export function getLogger(options?: LoggerOptions) {
  if (!sharedLogger) {
    sharedLogger = new RotatingFileLogger(options);
  }
  return sharedLogger;
}
