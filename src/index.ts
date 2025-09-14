import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendMessageAppleScript } from "./utils/applescript.js";
import { listChats, getMessagesByChatId, getMessagesByParticipant, appleEpochToUnixMs } from "./utils/sqlite.js";

function textContent(text: string) {
  return [{ type: "text", text } as const];
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
    await sendMessageAppleScript(recipient, text);
    return { content: textContent(`Sent message to ${recipient}.`) };
  }
);

// list_chats tool
server.tool(
  "list_chats",
  "List recent chats from Messages.db with participants and last-activity.",
  { limit: z.number().int().min(1).max(500).default(50) },
  async ({ limit }) => {
    try {
      const rows = await listChats(limit);
      const mapped = rows.map((r) => ({
        chat_id: r.chat_id,
        guid: r.guid,
        display_name: r.display_name,
        participants: r.participants ? r.participants.split(",") : [],
        last_message_unix_ms: appleEpochToUnixMs(r.last_message_date),
      }));
      return { content: textContent(JSON.stringify(mapped, null, 2)) };
    } catch (e) {
      const msg = `Failed to read Messages database. Grant Full Disk Access to your terminal/CLI and try again. Error: ${(e as Error).message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// get_messages tool
server.tool(
  "get_messages",
  "Get recent messages by chat_id or participant handle (phone/email).",
  {
    chat_id: z.number().int().optional(),
    participant: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
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
      return { content: textContent(JSON.stringify(mapped, null, 2)) };
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
