import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

type LogViewerOptions = {
  autoOpen?: boolean;
  sessionLabel?: string;
  pollIntervalMs?: number;
  onShutdownRequest?: () => void;
};

type LogChunkResponse = {
  chunk: string;
  offset: number;
  truncated: boolean;
};

const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_POLL_INTERVAL = 1500;

const htmlTemplate = (sessionLabel: string | undefined, pollInterval: number, shutdownEnabled: boolean) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>messages-app-mcp Log Viewer</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #101418;
        --fg: #f5f6f7;
        --warn: #ffb454;
        --error: #ff6b81;
        --info: #5fd1ff;
        --debug: #9fa6ad;
      }

      body {
        margin: 0;
        font-family: ui-monospace, "SFMono-Regular", SFMono, Consolas, "Liberation Mono", Menlo, monospace;
        background: var(--bg);
        color: var(--fg);
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      header {
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.04);
        backdrop-filter: blur(8px);
        font-size: 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: sticky;
        top: 0;
        z-index: 1;
      }

      header span {
        opacity: 0.7;
      }

      header button {
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        border-radius: 6px;
        padding: 6px 12px;
        font-size: 13px;
      }

      header button:hover {
        background: rgba(255, 255, 255, 0.18);
      }

      #content {
        flex: 1;
        overflow: auto;
        padding: 16px;
        white-space: pre-wrap;
        font-size: 13px;
        line-height: 1.45;
      }

      .WARN { color: var(--warn); }
      .ERROR { color: var(--error); }
      .INFO { color: var(--info); }
      .DEBUG { color: var(--debug); }

      .timestamp {
        opacity: 0.6;
        margin-right: 8px;
      }
    </style>
  </head>
  <body>
    <header>
      <div><strong>messages-app-mcp</strong> log viewer</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <span id="session"></span>
        ${shutdownEnabled ? '<button id="shutdown">Shut Down</button>' : ""}
      </div>
    </header>
    <div id="content"></div>
    <script>
      const params = new URLSearchParams(window.location.search);
      const sessionLabel = params.get("session") || ${JSON.stringify(sessionLabel ?? "session")};
      const content = document.getElementById('content');
      const sessionDisplay = document.getElementById('session');
      sessionDisplay.textContent = 'session: ' + sessionLabel;

      let offset = Number(params.get('offset')) || 0;
      const pollInterval = ${pollInterval};
      const levelRegex = /\[(DEBUG|INFO|WARN|ERROR)\]/;

      function appendLines(chunk) {
        if (!chunk) return;
        const lines = chunk.split(/\n/);
        const frag = document.createDocumentFragment();
        for (const line of lines) {
          if (!line) continue;
          const div = document.createElement('div');
          const levelMatch = line.match(levelRegex);
          let level = null;
          if (levelMatch) {
            level = levelMatch[1];
          }
          const timestampEnd = line.indexOf(']');
          if (timestampEnd > -1) {
            const ts = line.slice(0, timestampEnd + 1);
            const rest = line.slice(timestampEnd + 1);
            const spanTs = document.createElement('span');
            spanTs.className = 'timestamp';
            spanTs.textContent = ts + ' ';
            div.appendChild(spanTs);
            const spanRest = document.createElement('span');
            if (level) spanRest.className = level;
            spanRest.textContent = rest.trimStart();
            div.appendChild(spanRest);
          } else {
            div.textContent = line;
          }
          frag.appendChild(div);
        }
        content.appendChild(frag);
        content.scrollTop = content.scrollHeight;
      }

      async function poll() {
        try {
          const response = await fetch("/api/log?offset=" + offset);
          if (!response.ok) throw new Error('Failed to fetch log chunk');
          const data = await response.json();
          if (data.truncated && offset === 0) {
            content.textContent = '';
          }
          appendLines(data.chunk);
          offset = data.offset;
        } catch (error) {
          console.error('log poll failed', error);
        } finally {
          window.setTimeout(poll, pollInterval);
        }
      }

      ${shutdownEnabled ? `const shutdownBtn = document.getElementById('shutdown');
      if (shutdownBtn) {
        shutdownBtn.addEventListener('click', async () => {
          shutdownBtn.disabled = true;
          shutdownBtn.textContent = 'Shutting down…';
          try {
            await fetch('/api/shutdown', { method: 'POST' });
          } catch (error) {
            console.error('shutdown failed', error);
            shutdownBtn.disabled = false;
            shutdownBtn.textContent = 'Shut Down';
          }
        });
      }` : ""}

      poll();
    </script>
  </body>
</html>`;

function openInDefaultBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[] = [];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Swallow errors – we don't want failures to open a browser to crash the host.
  }
}

async function readLogChunk(logFilePath: string, offset: number, maxBytes: number): Promise<LogChunkResponse> {
  let handle;
  try {
    handle = await fsOpen(logFilePath, "r");
  } catch (error: any) {
    if (error && error.code === "ENOENT") {
      return { chunk: "", offset: 0, truncated: false };
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    const size = stats.size;
    if (size === 0) {
      return { chunk: "", offset: 0, truncated: false };
    }
    let start = Number.isFinite(offset) && offset >= 0 ? offset : 0;
    if (start > size) {
      start = size;
    }
    let truncated = false;
    if (size - start > maxBytes) {
      start = size - maxBytes;
      truncated = true;
    }
    const length = size - start;
    if (length <= 0) {
      return { chunk: "", offset: size, truncated: false };
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      chunk: buffer.toString("utf8"),
      offset: size,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

export interface LogViewerHandle {
  readonly port: number;
  readonly baseUrl: string;
  open(sessionLabel?: string): void;
  close(): Promise<void>;
}

export async function startLogViewer(logFilePath: string, options: LogViewerOptions = {}): Promise<LogViewerHandle> {
  const pollInterval = options.pollIntervalMs && options.pollIntervalMs > 250 ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL;
  const maxChunk = Number.parseInt(process.env.MESSAGES_MCP_LOG_VIEWER_MAX_CHUNK ?? "", 10) || DEFAULT_MAX_CHUNK_BYTES;

  const app = express();
  const shutdownEnabled = typeof options.onShutdownRequest === "function";

  app.get("/", (_req: Request, res: Response) => {
    res.type("html").send(htmlTemplate(options.sessionLabel, pollInterval, shutdownEnabled));
  });

  app.get("/api/log", async (req: Request, res: Response) => {
    const rawOffset = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
    const offset = rawOffset ? Number.parseInt(String(rawOffset), 10) : 0;
    try {
      const chunk = await readLogChunk(logFilePath, offset, maxChunk);
      res.json(chunk);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/healthz", async (_req: Request, res: Response) => {
    try {
      await fsStat(logFilePath);
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  if (shutdownEnabled) {
    app.post("/api/shutdown", (_req: Request, res: Response) => {
      res.json({ ok: true });
      try {
        options.onShutdownRequest?.();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("shutdown callback failed", error);
      }
    });
  }

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const httpServer = createServer(app);
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve(httpServer);
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const openedSessions = new Set<string>();

  const handle: LogViewerHandle = {
    port: address.port,
    baseUrl,
    open(sessionLabel?: string) {
      const label = sessionLabel && sessionLabel.trim().length > 0 ? sessionLabel.trim() : "session";
      if (openedSessions.has(label)) return;
      openedSessions.add(label);
      const url = `${baseUrl}/?session=${encodeURIComponent(label)}&nonce=${randomUUID()}`;
      openInDefaultBrowser(url);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  if (options.autoOpen) {
    handle.open(options.sessionLabel);
  }

  return handle;
}
