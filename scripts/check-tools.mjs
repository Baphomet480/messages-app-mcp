#!/usr/bin/env node
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function flattenSchemaDescriptions(schema) {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap(flattenSchemaDescriptions).filter(Boolean);
  const descriptions = [];
  if (typeof schema.description === "string" && schema.description.trim().length > 0) {
    descriptions.push(schema.description.trim());
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const value of Object.values(schema.properties)) {
      descriptions.push(...flattenSchemaDescriptions(value));
    }
  }
  if (schema.items) {
    descriptions.push(...flattenSchemaDescriptions(schema.items));
  }
  return descriptions.filter(Boolean);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--loader", "ts-node/esm", "src/index.ts"],
    env: {
      ...process.env,
      // Ensure metadata checks never trigger send side-effects
      MESSAGES_MCP_READONLY: "true",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stderr: "pipe",
    cwd: process.cwd(),
  });

  const client = new Client({
    name: "metadata-checker",
    version: "0.1.0",
  });

  const findings = [];
  const cleanup = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };

  try {
    await client.connect(transport);
    const { tools } = await client.listTools({});

    for (const tool of tools) {
      const title = stringOrNull(tool.title);
      const description = stringOrNull(tool.description);
      if (!title) {
        findings.push({ tool: tool.name, severity: "error", issue: "Missing title" });
      }
      if (!description) {
        findings.push({ tool: tool.name, severity: "error", issue: "Missing description" });
      }

      const schema = tool.inputSchema;
      if (!schema || typeof schema !== "object") {
        findings.push({ tool: tool.name, severity: "warn", issue: "Input schema not provided" });
      } else if (schema.properties && Object.keys(schema.properties).length > 0) {
        const descriptions = flattenSchemaDescriptions(schema);
        if (!descriptions.length) {
          findings.push({ tool: tool.name, severity: "warn", issue: "Input fields lack descriptions" });
        }
      }

      if (!tool.outputSchema) {
        findings.push({ tool: tool.name, severity: "warn", issue: "Output schema not provided" });
      }
    }

    const summary = { toolCount: tools.length, issues: findings };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("Metadata check failed:", error);
  process.exitCode = 1;
});
