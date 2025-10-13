#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv) {
  const args = { daysBack: 365, limit: 10, participant: null, query: "", tool: "safe" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--participant" && argv[i + 1]) {
      args.participant = argv[i + 1];
      i += 1;
    } else if (value === "--days-back" && argv[i + 1]) {
      args.daysBack = Number(argv[i + 1]);
      i += 1;
    } else if (value === "--limit" && argv[i + 1]) {
      args.limit = Number(argv[i + 1]);
      i += 1;
    } else if (value === "--query" && argv[i + 1]) {
      args.query = argv[i + 1];
      i += 1;
    } else if (value === "--tool" && argv[i + 1]) {
      args.tool = argv[i + 1].toLowerCase();
      i += 1;
    } else if (value === "--unsafe") {
      args.tool = "full";
    }
  }
  if (!args.participant) {
    throw new Error("--participant is required for this test script.");
  }
  if (!Number.isFinite(args.daysBack) || args.daysBack <= 0) {
    throw new Error("--days-back must be a positive number of days.");
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  if (!["safe", "full"].includes(args.tool)) {
    throw new Error("--tool must be 'safe' or 'full'.");
  }
  return args;
}

function sanitizeResult(entry) {
  return {
    message_rowid: entry.message_rowid ?? null,
    chat_id: entry.chat_id ?? null,
    iso_utc: entry.iso_utc ?? null,
    iso_local: entry.iso_local ?? null,
    from_me: Boolean(entry.from_me),
    has_attachments: Boolean(entry.has_attachments),
    attachment_hint_count: Array.isArray(entry.attachment_hints) ? entry.attachment_hints.length : 0,
  };
}

async function main() {
  const { participant, daysBack, limit, query, tool } = parseArgs(process.argv.slice(2));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--loader", "ts-node/esm", "src/index.ts"],
    env: {
      ...process.env,
      MESSAGES_MCP_READONLY: "true",
      MESSAGES_MCP_MASK_RECIPIENTS: process.env.MESSAGES_MCP_MASK_RECIPIENTS ?? "true",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stderr: "pipe",
    cwd: process.cwd(),
  });

  const client = new Client({
    name: "search-tester",
    version: "0.0.1",
  });

  const cleanup = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };

  try {
    await client.connect(transport);

    let result;
    if (tool === "safe") {
      if (daysBack > 365) {
        throw new Error("safe tool enforces days_back <= 365; use --tool full for longer ranges.");
      }
      result = await client.callTool({
        name: "search_messages_safe",
        arguments: {
          participant,
          days_back: Math.trunc(daysBack),
          limit: Math.trunc(limit),
          query: query || participant,
        },
      });
    } else {
      const fromUnix = Date.now() - Math.trunc(daysBack) * 86400000;
      result = await client.callTool({
        name: "search_messages",
        arguments: {
          participant,
          query: query || participant,
          from_unix_ms: Math.trunc(fromUnix),
          limit: Math.trunc(limit),
        },
      });
    }

    const structured = result.structuredContent;
    const results = Array.isArray(structured?.results) ? structured.results : [];

    const sanitized = results.map(sanitizeResult);
    const first = sanitized[0] ?? null;
    const last = sanitized[sanitized.length - 1] ?? null;
    const fromMeCount = sanitized.filter((entry) => entry.from_me).length;

    const summary = {
      participant,
      query: query || participant,
      tool,
      days_back: Math.trunc(daysBack),
      limit: Math.trunc(limit),
      result_count: sanitized.length,
      from_me_count: fromMeCount,
      first_iso_utc: first?.iso_utc ?? null,
      last_iso_utc: last?.iso_utc ?? null,
      sample: sanitized.slice(0, Math.min(5, sanitized.length)),
    };

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("Search test failed:", error);
  process.exitCode = 1;
});
