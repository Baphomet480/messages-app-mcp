#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendMessageAppleScript, runAppleScriptInline } from "./utils/applescript.js";
import { listChats, getMessagesByChatId, getMessagesByParticipant, appleEpochToUnixMs, searchMessages, contextAroundMessage, getAttachmentsForMessages } from "./utils/sqlite.js";
import { runDoctor } from "./utils/doctor.js";
import type { EnrichedMessageRow, AttachmentInfo } from "./utils/sqlite.js";

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

// Default: do NOT mask. Opt-in masking with MESSAGES_MCP_MASK_RECIPIENTS=true
function shouldMask(): boolean {
  const v = process.env.MESSAGES_MCP_MASK_RECIPIENTS;
  if (!v) return false;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function displayRecipient(recipient: string): string {
  return shouldMask() ? maskRecipient(recipient) : recipient;
}

function sanitizeText(s: string | null | undefined): string | null {
  if (s == null) return null;
  try {
    // Normalize and strip non-printables except common whitespace
    const n = s.normalize('NFC');
    const cleaned = n.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[\u2028\u2029]/g, '\n');
    return cleaned;
  } catch {
    return s;
  }
}

function isReadOnly(): boolean {
  const v = process.env.MESSAGES_MCP_READONLY;
  if (!v) return false;
  const normalized = String(v).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "readonly";
}

const READ_ONLY_MODE = isReadOnly();

function toIsoUtc(unixMs: number | null): string | null {
  if (unixMs == null) return null;
  try {
    return new Date(unixMs).toISOString();
  } catch {
    return null;
  }
}

function toIsoLocal(unixMs: number | null): string | null {
  if (unixMs == null) return null;
  try {
    const date = new Date(unixMs);
    const tzOffsetMinutes = -date.getTimezoneOffset();
    const sign = tzOffsetMinutes >= 0 ? "+" : "-";
    const absMinutes = Math.abs(tzOffsetMinutes);
    const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
    const minutes = String(absMinutes % 60).padStart(2, "0");
    const localDate = new Date(unixMs + date.getTimezoneOffset() * 60_000);
    const iso = localDate.toISOString().slice(0, 19);
    return `${iso}${sign}${hours}:${minutes}`;
  } catch {
    return null;
  }
}

const TAPBACK_TYPES: Record<number, { code: string; removed?: boolean }> = {
  2000: { code: "love" },
  2001: { code: "like" },
  2002: { code: "dislike" },
  2003: { code: "laugh" },
  2004: { code: "emphasize" },
  2005: { code: "question" },
  3000: { code: "love", removed: true },
  3001: { code: "like", removed: true },
  3002: { code: "dislike", removed: true },
  3003: { code: "laugh", removed: true },
  3004: { code: "emphasize", removed: true },
  3005: { code: "question", removed: true },
};

type NormalizedMessage = {
  message_rowid: number;
  chat_id?: number | null;
  guid: string;
  from_me: boolean;
  text: string | null;
  text_source: "text" | "attributedBody" | "none";
  sender: string | null;
  unix_ms: number | null;
  iso_utc: string | null;
  iso_local: string | null;
  has_attachments: boolean;
  attachment_hints?: Array<{ name: string; mime: string; filename: string; resolved_path?: string | null }>;
  service?: string | null;
  account?: string | null;
  subject?: string | null;
  message_type: "text" | "reaction" | "reaction_removed" | "effect" | "attachment" | "unknown";
  message_subtype?: string | null;
  metadata: Record<string, unknown>;
};

function normalizeMessage(row: EnrichedMessageRow & { chat_id?: number }): NormalizedMessage {
  const unix = appleEpochToUnixMs(row.date);
  const hints = row.attachments_meta?.map((meta) => ({
    name: meta.name,
    mime: meta.mime,
    filename: meta.filename,
  }));
  const hasAttachments = (row.has_attachments ?? 0) > 0 || (hints?.length ?? 0) > 0;
  let textSource: "text" | "attributedBody" | "none" = "none";
  let text = sanitizeText(row.text);
  if (text && text.trim().length > 0) {
    textSource = "text";
  } else if (row.decoded_text && row.decoded_text.trim().length > 0) {
    text = sanitizeText(row.decoded_text);
    textSource = "attributedBody";
  } else {
    text = null;
  }

  let messageType: NormalizedMessage["message_type"] = "unknown";
  let messageSubtype: string | null = null;
  const associatedType = row.associated_message_type ?? null;
  if (associatedType != null && TAPBACK_TYPES[associatedType]) {
    const info = TAPBACK_TYPES[associatedType];
    messageType = info.removed ? "reaction_removed" : "reaction";
    messageSubtype = `tapback_${info.code}`;
  } else if (row.expressive_send_style_id || row.balloon_bundle_id) {
    messageType = "effect";
    messageSubtype = row.expressive_send_style_id || row.balloon_bundle_id || null;
  } else if (hasAttachments && (!text || text.trim().length === 0)) {
    messageType = "attachment";
  } else if (text) {
    messageType = "text";
  }

  return {
    message_rowid: row.message_rowid,
    chat_id: row.chat_id,
    guid: row.guid,
    from_me: row.is_from_me === 1,
    text,
    text_source: textSource,
    sender: row.sender ?? null,
    unix_ms: unix,
    iso_utc: toIsoUtc(unix),
    iso_local: toIsoLocal(unix),
    has_attachments: hasAttachments,
    attachment_hints: hints,
    service: (row as any).service ?? null,
    account: (row as any).account ?? null,
    subject: (row as any).subject ?? null,
    message_type: messageType,
    message_subtype: messageSubtype,
    metadata: {
      associated_message_type: row.associated_message_type ?? null,
      associated_message_guid: row.associated_message_guid ?? null,
      thread_originator_guid: row.thread_originator_guid ?? null,
      reply_to_guid: row.reply_to_guid ?? null,
      expressive_send_style_id: row.expressive_send_style_id ?? null,
      balloon_bundle_id: row.balloon_bundle_id ?? null,
      item_type: row.item_type ?? null,
      message_type_raw: row.message_type_raw ?? null,
    },
  };
}

function normalizeMessages(rows: Array<EnrichedMessageRow & { chat_id?: number }>): NormalizedMessage[] {
  return rows.map((row) => normalizeMessage(row));
}

const normalizedMessageSchema = z.object({
  message_rowid: z.number(),
  chat_id: z.number().nullable().optional(),
  guid: z.string(),
  from_me: z.boolean(),
  text: z.string().nullable(),
  text_source: z.enum(["text", "attributedBody", "none"]),
  sender: z.string().nullable(),
  unix_ms: z.number().nullable(),
  iso_utc: z.string().nullable(),
  iso_local: z.string().nullable(),
  has_attachments: z.boolean(),
  attachment_hints: z.array(z.object({
    name: z.string(),
    mime: z.string(),
    filename: z.string().optional(),
    resolved_path: z.string().nullable().optional(),
  })).optional(),
  service: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  message_type: z.enum(["text", "reaction", "reaction_removed", "effect", "attachment", "unknown"]),
  message_subtype: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.any()),
});

const searchResultSchema = normalizedMessageSchema.extend({
  chat_id: z.number(),
  snippet: z.string().nullable(),
});

const attachmentRecordSchema = z.object({
  message_rowid: z.number(),
  attachment_rowid: z.number(),
  transfer_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  total_bytes: z.number().nullable(),
  filename: z.string().nullable(),
  resolved_path: z.string().nullable(),
  created_unix_ms: z.number().nullable(),
  created_iso_utc: z.string().nullable(),
  created_iso_local: z.string().nullable(),
});

function normalizeAttachment(info: AttachmentInfo) {
  const unix = info.created_unix_ms ?? null;
  return {
    message_rowid: info.message_rowid,
    attachment_rowid: info.attachment_rowid,
    transfer_name: info.transfer_name ?? null,
    mime_type: info.mime_type ?? null,
    total_bytes: info.total_bytes ?? null,
    filename: info.filename ?? null,
    resolved_path: info.resolved_path ?? null,
    created_unix_ms: unix,
    created_iso_utc: toIsoUtc(unix),
    created_iso_local: toIsoLocal(unix),
  };
}

const server = new McpServer(
  { name: "messages.app-mcp", version: "0.1.0" },
  {}
);

// send_text tool
if (READ_ONLY_MODE) {
  server.tool(
    "send_text",
    "Send a text/iMessage via Messages.app to a phone number or email.",
    {
      recipient: z.string().describe("Phone number in E.164 format or iMessage email."),
      text: z.string().min(1).describe("Message text to send."),
    },
    async ({ recipient }) => {
      const shown = displayRecipient(recipient);
      return {
        content: textContent(`Read-only mode is enabled; did not send to ${shown}.`),
        isError: true,
      };
    }
  );
} else {
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
}

// doctor tool: checks environment and prerequisites
server.registerTool(
  "doctor",
  {
    title: "Environment Doctor",
    description: "Diagnose Messages.app prerequisites: iMessage/SMS availability and DB access.",
    outputSchema: {
      ok: z.boolean(),
      osascript_available: z.boolean(),
      services: z.array(z.string()),
      accounts: z.array(z.string()),
      iMessage_available: z.boolean(),
      sms_available: z.boolean(),
      sqlite_access: z.boolean(),
      db_path: z.string(),
      notes: z.array(z.string()),
    }
  },
  async () => {
    const report = await runDoctor();
    const { summary, ...structured } = report;
    return {
      content: textContent(summary + (structured.notes.length ? `\nnotes:\n- ${structured.notes.join("\n- ")}` : "")),
      structuredContent: structured,
    };
  }
);

// list_chats tool with structured output
server.registerTool(
  "list_chats",
  {
    description: "List recent chats from Messages.db with participants and last-activity.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(50),
      participant: z.string().optional(),
      updated_after_unix_ms: z.number().int().optional(),
      unread_only: z.boolean().optional(),
    },
    outputSchema: {
      chats: z.array(z.object({
        chat_id: z.number(),
        guid: z.string(),
        display_name: z.string().nullable(),
        participants: z.array(z.string()),
        last_message_unix_ms: z.number().nullable(),
        last_message_iso_utc: z.string().nullable(),
        last_message_iso_local: z.string().nullable(),
        unread_count: z.number().nullable(),
      }))
    }
  },
  async ({ limit, participant, updated_after_unix_ms, unread_only }) => {
    try {
      const rows = await listChats(limit, {
        participant: participant ?? undefined,
        updatedAfterUnixMs: updated_after_unix_ms ?? undefined,
        unreadOnly: unread_only ?? false,
      });
      const mapped = rows.map((r) => {
        const unix = appleEpochToUnixMs(r.last_message_date);
        return {
          chat_id: r.chat_id,
          guid: r.guid,
          display_name: r.display_name ?? null,
          participants: r.participants ? r.participants.split(",") : [],
          last_message_unix_ms: unix,
          last_message_iso_utc: toIsoUtc(unix),
          last_message_iso_local: toIsoLocal(unix),
          unread_count: r.unread_count ?? null,
        };
      });
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
      context_anchor_rowid: z.number().int().optional(),
      context_before: z.number().int().min(0).max(200).default(10),
      context_after: z.number().int().min(0).max(200).default(10),
      context_include_attachments_meta: z.boolean().optional(),
    },
    outputSchema: {
      messages: z.array(normalizedMessageSchema),
      context: z.object({
        anchor_rowid: z.number(),
        before: z.number(),
        after: z.number(),
        include_attachments_meta: z.boolean(),
        messages: z.array(normalizedMessageSchema),
      }).optional(),
    }
  },
  async ({ chat_id, participant, limit, context_anchor_rowid, context_before, context_after, context_include_attachments_meta }) => {
    if (chat_id == null && !participant) {
      return { content: textContent("Provide either chat_id or participant."), isError: true };
    }
    try {
      const rows = chat_id != null
        ? await getMessagesByChatId(chat_id, limit)
        : await getMessagesByParticipant(participant!, limit);
      const mapped = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0));
      const structuredContent: { messages: NormalizedMessage[]; context?: { anchor_rowid: number; before: number; after: number; include_attachments_meta: boolean; messages: NormalizedMessage[] } } = { messages: mapped };
      if (context_anchor_rowid != null) {
        const ctxRows = await contextAroundMessage(context_anchor_rowid, context_before, context_after, !!context_include_attachments_meta);
        const ctxMessages = normalizeMessages(ctxRows as Array<EnrichedMessageRow & { chat_id?: number }>).sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0));
        structuredContent.context = {
          anchor_rowid: context_anchor_rowid,
          before: context_before,
          after: context_after,
          include_attachments_meta: !!context_include_attachments_meta,
          messages: ctxMessages,
        };
      }
      return {
        content: textContent(JSON.stringify(structuredContent, null, 2)),
        structuredContent,
      };
    } catch (e) {
      const msg = `Failed to query messages. Confirm Messages access (Full Disk Access) and that Messages is running at least once. Error: ${(e as Error).message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// search_messages tool
server.registerTool(
  "search_messages",
  {
    description: "Search messages by text with optional scoping and filters.",
    inputSchema: {
      query: z.string().min(1),
      chat_id: z.number().int().optional(),
      participant: z.string().optional(),
      from_unix_ms: z.number().int().optional(),
      to_unix_ms: z.number().int().optional(),
      from_me: z.boolean().optional(),
      has_attachments: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
      include_attachments_meta: z.boolean().optional(),
    },
    outputSchema: {
      results: z.array(searchResultSchema)
    }
  },
  async (input) => {
    if (input.chat_id == null && !input.participant && input.from_unix_ms == null && input.to_unix_ms == null) {
      return {
        content: textContent("Provide chat_id, participant, or from/to unix filters when searching to avoid full-database scans."),
        isError: true,
      };
    }
    try {
      const rows = await searchMessages({
        query: input.query,
        chatId: input.chat_id ?? undefined,
        participant: input.participant ?? undefined,
        fromUnixMs: input.from_unix_ms ?? undefined,
        toUnixMs: input.to_unix_ms ?? undefined,
        fromMe: input.from_me ?? undefined,
        hasAttachments: input.has_attachments ?? undefined,
        limit: input.limit,
        offset: input.offset,
        includeAttachmentsMeta: !!input.include_attachments_meta,
      });
      const lowerQ = input.query.toLowerCase();
      const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id: number }>);
      const chatLookup = new Map<number, number>();
      for (const row of rows as Array<EnrichedMessageRow & { chat_id: number }>) {
        chatLookup.set(row.message_rowid, row.chat_id);
      }
      const mapped = normalized.map((msg) => {
        const text = msg.text ?? "";
        const idx = text.toLowerCase().indexOf(lowerQ);
        let snippet: string | null = null;
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + lowerQ.length + 40);
          snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
        }
        const chatId = msg.chat_id ?? chatLookup.get(msg.message_rowid) ?? 0;
        return { ...msg, chat_id: chatId, snippet };
      });
      return {
        content: textContent(JSON.stringify(mapped, null, 2)),
        structuredContent: { results: mapped },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/scope filter/i.test(message) || /requires at least one scope/i.test(message)) {
        return {
          content: textContent("Provide chat_id, participant, or from/to unix filters when searching to avoid full-database scans."),
          isError: true,
        };
      }
      const msg = `Failed to search messages. Verify Full Disk Access and try narrowing your filters. Error: ${message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// context_around_message tool
server.registerTool(
  "context_around_message",
  {
    description: "Fetch N messages before and after a message_rowid within its chat (ordered by time).",
    inputSchema: {
      message_rowid: z.number().int(),
      before: z.number().int().min(0).max(200).default(10),
      after: z.number().int().min(0).max(200).default(10),
      include_attachments_meta: z.boolean().optional(),
    },
    outputSchema: {
      messages: z.array(normalizedMessageSchema)
    }
  },
  async ({ message_rowid, before, after, include_attachments_meta }) => {
    const rows = await contextAroundMessage(message_rowid, before, after, !!include_attachments_meta);
    const mapped = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0));
    return {
      content: textContent(JSON.stringify(mapped, null, 2)),
      structuredContent: { messages: mapped },
    };
  }
);

// get_attachments tool
server.registerTool(
  "get_attachments",
  {
    description: "Fetch attachment metadata and resolved file paths for specific message row IDs (per-message cap enforced).",
    inputSchema: {
      message_rowids: z.array(z.number().int()).min(1).max(50),
      per_message_cap: z.number().int().min(1).max(10).default(5),
    },
    outputSchema: {
      attachments: z.array(attachmentRecordSchema),
    }
  },
  async ({ message_rowids, per_message_cap }) => {
    try {
      const infos = await getAttachmentsForMessages(message_rowids, per_message_cap);
      const mapped = infos.map((info) => normalizeAttachment(info));
      return {
        content: textContent(JSON.stringify(mapped, null, 2)),
        structuredContent: { attachments: mapped },
      };
    } catch (e) {
      const msg = `Failed to retrieve attachments. Confirm database access permissions. Error: ${(e as Error).message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// search_messages_safe tool enforces scope/recency
server.registerTool(
  "search_messages_safe",
  {
    description: "Global search with required scope: must provide chat_id, participant, or days_back (defaults to 30). Hard cap on limit.",
    inputSchema: {
      query: z.string().min(1),
      chat_id: z.number().int().optional(),
      participant: z.string().optional(),
      days_back: z.number().int().min(1).max(365).default(30),
      from_me: z.boolean().optional(),
      has_attachments: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      include_attachments_meta: z.boolean().optional(),
    },
    outputSchema: {
      results: z.array(searchResultSchema)
    }
  },
  async (input) => {
    if (input.chat_id == null && !input.participant && !(input.days_back && input.days_back > 0)) {
      return { content: textContent("Provide chat_id, participant, or days_back."), isError: true };
    }
    const now = Date.now();
    const from = input.chat_id != null || input.participant ? undefined : (now - (input.days_back ?? 30) * 86400000);
    try {
      const rows = await searchMessages({
        query: input.query,
        chatId: input.chat_id ?? undefined,
        participant: input.participant ?? undefined,
        fromUnixMs: from,
        toUnixMs: undefined,
        fromMe: input.from_me ?? undefined,
        hasAttachments: input.has_attachments ?? undefined,
        limit: input.limit,
        offset: input.offset,
        includeAttachmentsMeta: !!input.include_attachments_meta,
      });
      const lowerQ = input.query.toLowerCase();
      const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id: number }>);
      const chatLookup = new Map<number, number>();
      for (const row of rows as Array<EnrichedMessageRow & { chat_id: number }>) {
        chatLookup.set(row.message_rowid, row.chat_id);
      }
      const mapped = normalized.map((msg) => {
        const text = msg.text ?? "";
        const idx = text.toLowerCase().indexOf(lowerQ);
        let snippet: string | null = null;
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + lowerQ.length + 40);
          snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
        }
        const chatId = msg.chat_id ?? chatLookup.get(msg.message_rowid) ?? 0;
        return { ...msg, chat_id: chatId, snippet };
      });
      return {
        content: textContent(JSON.stringify(mapped, null, 2)),
        structuredContent: { results: mapped },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const msg = `Failed to search messages safely. Error: ${message}`;
      return { content: textContent(msg), isError: true };
    }
  }
);

// summarize_window tool
server.registerTool(
  "summarize_window",
  {
    description: "Summarize a small window around an anchor message (by rowid) for low-token analysis.",
    inputSchema: {
      message_rowid: z.number().int(),
      before: z.number().int().min(0).max(200).default(50),
      after: z.number().int().min(0).max(200).default(50),
      max_chars: z.number().int().min(200).max(20000).default(2000),
    },
    outputSchema: {
      summary: z.string(),
      lines: z.array(z.string()),
    }
  },
  async ({ message_rowid, before, after, max_chars }) => {
    const rows = await contextAroundMessage(message_rowid, before, after, false);
    const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort((a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0));
    const ordered = normalized.map((msg) => ({
      t: msg.unix_ms ?? 0,
      from: msg.from_me ? "me" : (msg.sender || "other"),
      text: msg.text || "",
    }));
    const start = ordered[0]?.t;
    const end = ordered[ordered.length - 1]?.t;
    const participants = Array.from(new Set(ordered.map((r) => r.from)));
    const counts = ordered.reduce((acc: Record<string, number>, r) => {
      acc[r.from] = (acc[r.from] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const summary = `Window: ${start ? new Date(start).toISOString() : ""} → ${end ? new Date(end).toISOString() : ""} | Participants: ${participants.join(', ')} | Counts: ${Object.entries(counts).map(([k,v])=>k+': '+v).join(', ')}`;
    const lines: string[] = [];
    for (const r of ordered) {
      const stamp = new Date(r.t).toLocaleString('en-US', { hour12: false });
      const line = `${stamp} ${r.from}: ${r.text}`;
      lines.push(line);
    }
    // Trim to max_chars
    let out: string[] = [];
    let used = 0;
    for (const l of lines) {
      if (used + l.length + 1 > max_chars) break;
      out.push(l); used += l.length + 1;
    }
    return {
      content: textContent(summary + "\n" + out.join("\n")),
      structuredContent: { summary, lines: out },
    };
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
