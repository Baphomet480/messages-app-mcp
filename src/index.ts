import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendMessageAppleScript } from "./utils/applescript.js";
import { listChats, getMessagesByChatId, getMessagesByParticipant, appleEpochToUnixMs } from "./utils/sqlite.js";

function textContent(text: string) {
  return [{ type: "text", text } as const];
}

function maskRecipient(recipient: string): string {
  if (!recipient) return "";
  if (recipient.includes("@")) {
    const [local, domain] = recipient.split("@");
    if (!domain) return "***";
    const first = local.slice(0, 1) || "*";
    return `${first}***@${domain}`;
  }
  const digitsOnly = recipient.replace(/\D/g, "");
  if (digitsOnly.length <= 4) return recipient;
  let seen = 0;
  let result = "";
  for (const ch of recipient) {
    if (/\d/.test(ch)) {
      const remaining = digitsOnly.length - seen;
      result += remaining > 4 ? "•" : ch;
      seen++;
    } else {
      result += ch;
    }
  }
  return result;
}

function cleanOsaError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let m = String(raw);
  m = m.replace(/^osascript failed:\s*/i, "");
  m = m.replace(/execution error:\s*/i, "");
  m = m.replace(/messages? got an error:\s*/i, "");
  m = m.replace(/\s*\([\-\d]+\)\s*$/i, "");
  m = m.replace(/^"|"$/g, "");
  return m.trim();
}

function wantReveal(): boolean {
  const v = process.env.MESSAGES_MCP_SHOW_FULL_RECIPIENTS;
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function displayRecipient(recipient: string): string {
  return wantReveal() ? recipient : maskRecipient(recipient);
}

const server = new McpServer(
  { name: "messages.app-mcp", version: "0.1.0" },
  {}
);

// send_text tool
server.tool(
  "send_text",
  "Send a text/iMessage via Messages.app to a phone number or email.",
  {
    recipient: z.string().describe("Phone number in E.164 format or iMessage email."),
    text: z.string().min(1).describe("Message text to send."),
  },
  async ({ recipient, text }) => {
    try {
      await sendMessageAppleScript(recipient, text);
      const shown = displayRecipient(recipient);
      return { content: textContent(`Sent message to ${shown}.`) };
    } catch (e) {
      const shown = displayRecipient(recipient);
      const reason = cleanOsaError(e);
      return { content: textContent(`Failed to send to ${shown}. ${reason}`), isError: true };
    }
  }
);

// list_chats tool with structured output
server.registerTool(
  "list_chats",
  {
    description: "List recent chats from Messages.db with participants and last-activity.",
    inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
    outputSchema: {
      chats: z.array(z.object({
        chat_id: z.number(),
        guid: z.string(),
        display_name: z.string().nullable(),
        participants: z.array(z.string()),
        last_message_unix_ms: z.number().nullable(),
      }))
    }
  },
  async ({ limit }) => {
    try {
      const rows = await listChats(limit);
      const mapped = rows.map((r) => ({
        chat_id: r.chat_id,
        guid: r.guid,
        display_name: r.display_name ?? null,
        participants: r.participants ? r.participants.split(",") : [],
        last_message_unix_ms: appleEpochToUnixMs(r.last_message_date),
      }));
      const structuredContent = { chats: mapped };
      return {
        content: textContent(JSON.stringify(mapped, null, 2)),
        structuredContent,
      };
    } catch (e) {
      const msg = `Failed to read Messages database. Grant Full Disk Access to your terminal/CLI and try again. Error: ${(e as Error).message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// get_messages tool with structured output
server.registerTool(
  "get_messages",
  {
    description: "Get recent messages by chat_id or participant handle (phone/email).",
    inputSchema: {
      chat_id: z.number().int().optional(),
      participant: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    outputSchema: {
      messages: z.array(z.object({
        message_rowid: z.number(),
        guid: z.string(),
        from_me: z.boolean(),
        text: z.string().nullable(),
        sender: z.string().nullable(),
        unix_ms: z.number().nullable(),
        has_attachments: z.boolean(),
      }))
    }
  },
  async ({ chat_id, participant, limit }) => {
    if (chat_id == null && !participant) {
      return { content: textContent("Provide either chat_id or participant."), isError: true };
    }
    try {
      const rows = chat_id != null
        ? await getMessagesByChatId(chat_id, limit)
        : await getMessagesByParticipant(participant!, limit);
      const mapped = rows.map((m) => ({
        message_rowid: m.message_rowid,
        guid: m.guid,
        from_me: m.is_from_me === 1,
        text: m.text ?? null,
        sender: m.sender ?? null,
        unix_ms: appleEpochToUnixMs(m.date),
        has_attachments: m.has_attachments === 1,
      })).sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0));
      const structuredContent = { messages: mapped };
      return {
        content: textContent(JSON.stringify(mapped, null, 2)),
        structuredContent,
      };
    } catch (e) {
      const msg = `Failed to query messages. Grant Full Disk Access to your terminal/CLI and try again. Error: ${(e as Error).message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("messages.app-mcp failed:", err);
  process.exit(1);
});
