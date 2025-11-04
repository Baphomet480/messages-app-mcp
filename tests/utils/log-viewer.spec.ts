import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { startLogViewer } from "../../src/utils/log-viewer.js";

async function makeTempLogFile(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "log-viewer-"));
  const logFile = join(tempDir, "messages-app-mcp.log");
  await writeFile(logFile, "", "utf8");
  return logFile;
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("unexpected address format");
  }
  return (address as AddressInfo).port;
}

test("log viewer template escapes regex sensitive sequences", async () => {
  const logFile = await makeTempLogFile();

  const handle = await startLogViewer(logFile, { autoOpen: false });
  try {
    const response = await fetch(handle.baseUrl);
    expect(response.ok).toBe(true);
    const html = await response.text();
    const expectedRegex = String.raw`new RegExp("\\[(DEBUG|INFO|WARN|ERROR)\\]")`;
    const expectedSplit = String.raw`split(/\n/)`;
    expect(html).toContain(expectedRegex);
    expect(html).toContain(expectedSplit);
  } finally {
    await handle.close();
  }
});

test("log viewer respects a requested port when it is available", async () => {
  const logFile = await makeTempLogFile();
  const port = await reserveAvailablePort();

  const handle = await startLogViewer(logFile, { autoOpen: false, port });
  try {
    expect(handle.port).toBe(port);
    expect(handle.baseUrl).toBe(`http://127.0.0.1:${port}`);
  } finally {
    await handle.close();
  }
});
