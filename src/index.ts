#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendMessageAppleScript, sendAttachmentAppleScript, MESSAGES_FDA_HINT, type SendTarget } from "./utils/applescript.js";
import {
  listChats,
  getMessagesByChatId,
  getMessagesByParticipant,
  appleEpochToUnixMs,
  searchMessages,
  contextAroundMessage,
  getAttachmentsForMessages,
  getChatIdByGuid,
  getChatIdByDisplayName,
  getChatIdByParticipant,
} from "./utils/sqlite.js";
import { buildSendFailurePayload, buildSendSuccessPayload } from "./utils/send-result.js";
import type { MessageLike, SendTargetDescriptor, SendResultPayload } from "./utils/send-result.js";
import { getVersionInfo, getVersionInfoSync } from "./utils/version.js";
import { runDoctor } from "./utils/doctor.js";
import { getLogger } from "./utils/logger.js";
import type { EnrichedMessageRow, AttachmentInfo } from "./utils/sqlite.js";

const logger = getLogger();

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
});

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

function truncateForLog(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
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

type SendTargetInput = {
  recipient?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
};

function describeSendTarget(input: SendTargetInput): string {
  if (input.chat_name && input.chat_name.trim().length > 0) {
    return `chat "${input.chat_name.trim()}"`;
  }
  if (input.chat_guid && input.chat_guid.trim().length > 0) {
    return `chat ${input.chat_guid.trim()}`;
  }
  if (input.recipient && input.recipient.trim().length > 0) {
    return displayRecipient(input.recipient.trim());
  }
  return "target";
}

function buildTargetDescriptor(input: SendTargetInput): SendTargetDescriptor {
  return {
    recipient: input.recipient?.trim() ?? null,
    chat_guid: input.chat_guid?.trim() ?? null,
    chat_name: input.chat_name?.trim() ?? null,
    display: describeSendTarget(input),
  };
}

function hasTarget(input: SendTargetInput): boolean {
  return Boolean(
    (input.recipient && input.recipient.trim()) ||
    (input.chat_guid && input.chat_guid.trim()) ||
    (input.chat_name && input.chat_name.trim()),
  );
}

function buildSendTarget(input: SendTargetInput): SendTarget {
  if (!hasTarget(input)) {
    throw new Error("Provide recipient, chat_guid, or chat_name.");
  }
  const target: SendTarget = {};
  if (input.chat_guid && input.chat_guid.trim().length > 0) {
    target.chatGuid = input.chat_guid.trim();
  }
  if (input.chat_name && input.chat_name.trim().length > 0) {
    target.chatName = input.chat_name.trim();
  }
  if (input.recipient && input.recipient.trim().length > 0) {
    target.recipient = input.recipient.trim();
  }
  return target;
}

async function resolveChatIdForTarget(input: SendTargetInput): Promise<number | null> {
  if (input.chat_guid && input.chat_guid.trim().length > 0) {
    const resolved = await getChatIdByGuid(input.chat_guid.trim());
    if (resolved != null) return resolved;
  }
  if (input.chat_name && input.chat_name.trim().length > 0) {
    const resolved = await getChatIdByDisplayName(input.chat_name.trim());
    if (resolved != null) return resolved;
  }
  if (input.recipient && input.recipient.trim().length > 0) {
    const resolved = await getChatIdByParticipant(input.recipient.trim());
    if (resolved != null) return resolved;
  }
  return null;
}

async function collectRecentMessages(
  input: SendTargetInput,
  limit = 10,
): Promise<{ chatId: number | null; messages: NormalizedMessage[]; lookupError: string | null }> {
  let chatId: number | null = null;
  let lookupError: string | null = null;
  let messages: NormalizedMessage[] = [];
  try {
    chatId = await resolveChatIdForTarget(input);
    if (chatId != null) {
      const recentRows = await getMessagesByChatId(chatId, limit);
      const rowsWithChat = recentRows.map((row) => ({ ...row, chat_id: chatId })) as Array<
        EnrichedMessageRow & { chat_id?: number }
      >;
      messages = normalizeMessages(rowsWithChat);
    }
  } catch (err) {
    lookupError = err instanceof Error ? err.message : String(err);
  }
  return { chatId, messages, lookupError };
}

const OBJECT_REPLACEMENT_ONLY = /^[\uFFFC\uFFFD]+$/;

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

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampNumber(parsed, min, max);
}

function parseEnvBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clampNumber(parsed, 1, 65535);
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const CONNECTOR_DEFAULT_DAYS_BACK = parseEnvInt("MESSAGES_MCP_CONNECTOR_DAYS_BACK", 30, 1, 365);
const CONNECTOR_DEFAULT_LIMIT = parseEnvInt("MESSAGES_MCP_CONNECTOR_SEARCH_LIMIT", 20, 1, 50);
const CONNECTOR_BASE_URL = (process.env.MESSAGES_MCP_CONNECTOR_BASE_URL || "").trim().replace(/\/+$/, "");

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

type NormalizedMessage = MessageLike & {
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
  if (text && text.trim().length > 0 && OBJECT_REPLACEMENT_ONLY.test(text.trim())) {
    text = null;
  }
  if (text && text.trim().length > 0) {
    textSource = "text";
  } else if (row.decoded_text && row.decoded_text.trim().length > 0) {
    text = sanitizeText(row.decoded_text);
    if (text && text.trim().length > 0 && OBJECT_REPLACEMENT_ONLY.test(text.trim())) {
      text = null;
    }
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

  const metadata: Record<string, unknown> = {
    associated_message_type: row.associated_message_type ?? null,
    associated_message_guid: row.associated_message_guid ?? null,
    thread_originator_guid: row.thread_originator_guid ?? null,
    reply_to_guid: row.reply_to_guid ?? null,
    expressive_send_style_id: row.expressive_send_style_id ?? null,
    balloon_bundle_id: row.balloon_bundle_id ?? null,
    item_type: row.item_type ?? null,
    message_type_raw: row.message_type_raw ?? null,
  };
  if (row.attributed_body_meta) {
    metadata.attributed_body = row.attributed_body_meta;
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
    metadata,
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

// Send result schemas for tool self-description
const sendTargetDescriptorSchema = z.object({
  recipient: z.string().nullable(),
  chat_guid: z.string().nullable(),
  chat_name: z.string().nullable(),
  display: z.string(),
});

const sendSuccessSchema = z.object({
  status: z.literal("sent"),
  summary: z.string(),
  target: sendTargetDescriptorSchema,
  chat_id: z.number().nullable().optional(),
  latest_message: normalizedMessageSchema.nullable().optional(),
  recent_messages: z.array(normalizedMessageSchema).optional(),
  lookup_error: z.string().optional(),
});

const sendFailureSchema = z.object({
  status: z.literal("failed"),
  summary: z.string(),
  target: sendTargetDescriptorSchema,
  error: z.string(),
});


const attachmentMetaSchema = z.object({
  file_path: z.string().nullable(),
  file_label: z.string().nullable(),
  caption: z.string().nullable(),
});

// Note: MCP outputSchema prefers a single object shape; use permissive object with optional fields
const sendStandardOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  target: sendTargetDescriptorSchema,
  chat_id: z.number().nullable().optional(),
  latest_message: normalizedMessageSchema.nullable().optional(),
  recent_messages: z.array(normalizedMessageSchema).optional(),
  error: z.string().nullable().optional(),
  lookup_error: z.string().optional(),
  attachment: attachmentMetaSchema.optional(),
});

function toStandardSendOutput(payload: SendResultPayload<NormalizedMessage>, extra?: { attachment?: { file_path: string | null; file_label: string | null; caption: string | null } }) {
  if ((payload as any).status === "sent") {
    const p = payload as any;
    return {
      ok: true,
      summary: p.summary,
      target: p.target,
      chat_id: p.chat_id ?? null,
      latest_message: p.latest_message ?? null,
      recent_messages: p.recent_messages ?? [],
      lookup_error: p.lookup_error,
      attachment: extra?.attachment,
    };
  }
  const p = payload as any;
  return {
    ok: false,
    summary: p.summary,
    target: p.target,
    chat_id: null,
    latest_message: null,
    recent_messages: [],
    error: p.error,
    lookup_error: p.lookup_error,
    attachment: extra?.attachment,
  };
}

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

const SERVER_INSTRUCTIONS = [
  "messages-app-mcp bridges macOS Messages.app to MCP clients.",
  "",
  "Core tools:",
  "- list_chats / get_messages / context_around_message: browse conversation history with attachment metadata.",
  "- send_text / send_attachment: deliver new messages when MESSAGES_MCP_READONLY is not set.",
  "- search_messages / search_messages_safe / search: scoped full-text search utilities with connector-friendly output.",
  "- doctor: verifies AppleScript, Full Disk Access, and accounts before sending.",
  "- about: returns version, git commit, and runtime environment.",
  "",
  "Grant Full Disk Access to the invoking shell so chat.db can be read and attachments can be sent.",
].join("\n");

function createConfiguredServer(): McpServer {
  const versionInfo = getVersionInfoSync();
  const server = new McpServer(
    {
      name: versionInfo.name,
      title: "Messages.app MCP Server",
      version: versionInfo.version,
      description: "Expose macOS Messages history, search, and sending flows over MCP.",
      websiteUrl: "https://github.com/Baphomet480/messages-app-mcp",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const sendTextInputSchema = {
    recipient: z.string().min(1).describe("Phone number in E.164 format or iMessage email.").optional(),
    chat_guid: z.string().min(1).describe("chat.db GUID, e.g., chat1234567890abcdef.").optional(),
    chat_name: z.string().min(1).describe("Display name from Messages sidebar.").optional(),
    text: z.string().min(1).describe("Message text to send."),
  };

  const sendAttachmentInputSchema = {
    recipient: z.string().min(1).describe("Phone number in E.164 format or iMessage email.").optional(),
    chat_guid: z.string().min(1).describe("chat.db GUID, e.g., chat1234567890abcdef.").optional(),
    chat_name: z.string().min(1).describe("Display name from Messages sidebar.").optional(),
    file_path: z.string().min(1).describe("Path to the file to send."),
    caption: z.string().optional().describe("Optional caption sent before the attachment."),
  };

  const APPLESCRIPT_HANDLER_TEMPLATE = `-- Save as ~/Library/Application Scripts/com.apple.iChat/messages-mcp.scpt
  using terms from application "Messages"
    on message received theMessage from theBuddy for theChat
      try
        -- Forward minimal payload to MCP via CLI, HTTP hook, etc.
        do shell script "/usr/bin/logger 'messages-mcp incoming: ' & quoted form of theMessage"
      on error handlerError
        do shell script "/usr/bin/logger 'messages-mcp handler error: ' & quoted form of handlerError"
      end try
    end message received

    on message sent theMessage for theChat
      -- Example: notify MCP of outbound messages
      try
        do shell script "/usr/bin/logger 'messages-mcp sent: ' & quoted form of theMessage"
      end try
    end message sent

    on received file transfer invitation theTransfer
      -- Auto-accept incoming attachments
      try
        accept theTransfer
      end try
    end received file transfer invitation
  end using terms from`;

  function renderHandlerTemplate(minimal = false): string {
    if (!minimal) return APPLESCRIPT_HANDLER_TEMPLATE;
    return APPLESCRIPT_HANDLER_TEMPLATE
      .split("\n")
      .filter((line) => line.trim().length === 0 || !line.trim().startsWith("--"))
      .join("\n");
  }

  // send_text tool
  if (READ_ONLY_MODE) {
    server.registerTool(
      "send_text",
      {
        title: "Send Text",
        description: "Send a text/iMessage via Messages.app to a phone number or email.",
        inputSchema: sendTextInputSchema,
        outputSchema: sendStandardOutputSchema.shape,
      },
      async ({ recipient, chat_guid, chat_name }) => {
        const base = { recipient, chat_guid, chat_name };
        if (!hasTarget(base)) {
          return {
            content: textContent("Missing target. Provide recipient, chat_guid, or chat_name."),
            isError: true,
          };
        }
        const targetDescriptor = buildTargetDescriptor(base);
        const failure = buildSendFailurePayload(targetDescriptor, "Read-only mode is enabled.");
        logger.warn("send_text skipped in read-only mode", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
        });
        const std = toStandardSendOutput(failure);
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
      }
    );
  } else {
    server.registerTool(
      "send_text",
      {
        title: "Send Text",
        description: "Send a text/iMessage via Messages.app to a phone number or email.",
        inputSchema: sendTextInputSchema,
        outputSchema: sendStandardOutputSchema.shape,
      },
      async ({ recipient, chat_guid, chat_name, text }) => {
        const base = { recipient, chat_guid, chat_name };
        const targetDescriptor = buildTargetDescriptor(base);
        try {
          const target = buildSendTarget(base);
          await sendMessageAppleScript(target, text);

          const { chatId, messages, lookupError } = await collectRecentMessages(base);
          const payload = buildSendSuccessPayload<NormalizedMessage>({
            target: targetDescriptor,
            chatId,
            messages,
            lookupError,
          });
          const std = toStandardSendOutput(payload);
          logger.info("send_text success", {
            target: targetDescriptor.display,
            recipient: maskRecipient(recipient ?? ""),
            chat_id: chatId ?? null,
            message_preview: truncateForLog(text),
            latest_message_id: payload.latest_message?.message_rowid ?? null,
            lookup_error: lookupError ?? null,
          });
          return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std };
        } catch (e) {
          const reason = cleanOsaError(e);
          const failure = buildSendFailurePayload(targetDescriptor, reason);
          const std = toStandardSendOutput(failure);
          logger.error("send_text failed", {
            target: targetDescriptor.display,
            recipient: maskRecipient(recipient ?? ""),
            error: reason,
            message_preview: truncateForLog(text),
          });
          return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
        }
      }
    );
  }

  if (READ_ONLY_MODE) {
    server.registerTool(
      "send_attachment",
      {
        title: "Send Attachment",
        description: "Send an attachment via Messages.app to a recipient or existing chat.",
        inputSchema: sendAttachmentInputSchema,
        outputSchema: sendStandardOutputSchema.shape,
      },
      async ({ recipient, chat_guid, chat_name }) => {
        const base = { recipient, chat_guid, chat_name };
        if (!hasTarget(base)) {
          return {
            content: textContent("Missing target. Provide recipient, chat_guid, or chat_name."),
            isError: true,
          };
        }
        const targetDescriptor = buildTargetDescriptor(base);
        const failure = buildSendFailurePayload(targetDescriptor, "Read-only mode is enabled.");
        logger.warn("send_attachment skipped in read-only mode", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
        });
        const std = toStandardSendOutput(failure);
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
      }
    );
  } else {
    server.registerTool(
      "send_attachment",
      {
        title: "Send Attachment",
        description: "Send an attachment via Messages.app to a recipient or existing chat.",
        inputSchema: sendAttachmentInputSchema,
        outputSchema: sendStandardOutputSchema.shape,
      },
      async ({ recipient, chat_guid, chat_name, file_path, caption }) => {
        const base = { recipient, chat_guid, chat_name };
        const trimmedPath = file_path?.trim?.() ?? file_path;
        try {
          const target = buildSendTarget(base);
          await sendAttachmentAppleScript(target, trimmedPath, caption);
          const targetDescriptor = buildTargetDescriptor(base);

          const fileLabel = trimmedPath ? basename(trimmedPath) : null;
          const labelSegment = fileLabel ? `"${fileLabel}" ` : "";
          const summary = `Sent attachment ${labelSegment}to ${targetDescriptor.display}.`.trim();

          const { chatId, messages, lookupError } = await collectRecentMessages(base);
          const basePayload = buildSendSuccessPayload<NormalizedMessage>({
            target: targetDescriptor,
            chatId,
            messages,
            lookupError,
            summary,
          });
          const std = toStandardSendOutput(basePayload, {
            attachment: {
              file_path: trimmedPath ?? null,
              file_label: fileLabel,
              caption: caption?.trim?.() ?? null,
            },
          });
          logger.info("send_attachment success", {
            target: targetDescriptor.display,
            recipient: maskRecipient(recipient ?? ""),
            chat_id: chatId ?? null,
            file_label: fileLabel,
            caption_preview: truncateForLog(caption),
            latest_message_id: basePayload.latest_message?.message_rowid ?? null,
            lookup_error: lookupError ?? null,
          });
          return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std };
        } catch (e) {
          const targetDescriptor = buildTargetDescriptor(base);
          const reason =
            e instanceof Error && e.message === MESSAGES_FDA_HINT
              ? e.message
              : cleanOsaError(e);
          const summary = `Failed to send attachment to ${targetDescriptor.display}. ${reason}`.trim();
          const failure = buildSendFailurePayload(targetDescriptor, reason, { summary });
          const std = toStandardSendOutput(failure);
          logger.error("send_attachment failed", {
            target: targetDescriptor.display,
            recipient: maskRecipient(recipient ?? ""),
            error: reason,
            file_path: trimmedPath ?? null,
            caption_preview: truncateForLog(caption),
          });
          return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
        }
      }
    );
  }

  server.registerTool(
    "applescript_handler_template",
    {
      title: "AppleScript Handler Template",
      description: "Return a starter AppleScript for Messages event handlers (message received/sent, file transfer).",
      inputSchema: { minimal: z.boolean().optional().describe("Set true to omit inline comments.") },
      outputSchema: { script: z.string() },
    },
    async ({ minimal }) => {
      const script = renderHandlerTemplate(Boolean(minimal));
      const msg = `Save this AppleScript as ~/Library/Application Scripts/com.apple.iChat/messages-mcp.scpt and enable scripting in Messages.\n\n${script}`;
      return { content: textContent(msg), structuredContent: { script } };
    }
  );

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
        package_name: z.string(),
        package_version: z.string(),
        git_commit: z.string().nullable(),
        git_commit_short: z.string().nullable(),
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

  server.registerTool(
    "about",
    {
      title: "About messages-app-mcp",
      description: "Return version, build, and repository metadata about this MCP server.",
      outputSchema: {
        name: z.string(),
        version: z.string(),
        git_commit: z.string().nullable(),
        git_commit_short: z.string().nullable(),
        repository: z.string().url(),
        documentation: z.string().url(),
        maintainer: z.string().optional(),
        generated_at: z.string(),
        environment: z.object({
          node_version: z.string(),
          platform: z.string(),
        }),
      },
    },
    async () => {
      const version = await getVersionInfo();
      const payload = {
        name: version.name,
        version: version.version,
        git_commit: version.git_commit,
        git_commit_short: version.git_commit_short,
        repository: "https://github.com/Baphomet480/messages-app-mcp",
        documentation: "https://github.com/Baphomet480/messages-app-mcp#readme",
        maintainer: "Matthias (messages-app-mcp)",
        generated_at: new Date().toISOString(),
        environment: {
          node_version: process.version,
          platform: `${process.platform} ${process.arch}`,
        },
      } as const;
      return {
        content: textContent(JSON.stringify(payload, null, 2)),
        structuredContent: payload,
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
        const summaryParts: string[] = [];
        if (chat_id != null) summaryParts.push(`chat_id=${chat_id}`);
        if (participant) summaryParts.push(`participant=${participant}`);
        summaryParts.push(`limit=${limit}`);
        const summary = `Retrieved ${mapped.length} messages${summaryParts.length ? ` (${summaryParts.join(", ")})` : ""}.`;
        const structuredContent: {
          summary: string;
          messages: NormalizedMessage[];
          context?: {
            anchor_rowid: number;
            before: number;
            after: number;
            include_attachments_meta: boolean;
            messages: NormalizedMessage[];
          };
        } = { summary, messages: mapped };
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
        const jsonText = JSON.stringify(structuredContent, null, 2);
        return {
          content: textContent(jsonText),
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
        logger.warn("search_messages rejected", {
          query: input.query,
          reason: "missing_scope_filters",
        });
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
        logger.info("search_messages", {
          query: input.query,
          chat_id: input.chat_id ?? null,
          participant: input.participant ?? null,
          from_unix_ms: input.from_unix_ms ?? null,
          to_unix_ms: input.to_unix_ms ?? null,
          limit: input.limit,
          offset: input.offset,
          result_count: mapped.length,
        });
        return {
          content: textContent(JSON.stringify(mapped, null, 2)),
          structuredContent: { results: mapped },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/scope filter/i.test(message) || /requires at least one scope/i.test(message)) {
          logger.warn("search_messages rejected", {
            query: input.query,
            reason: message,
          });
          return {
            content: textContent("Provide chat_id, participant, or from/to unix filters when searching to avoid full-database scans."),
            isError: true,
          };
        }
        const msg = `Failed to search messages. Verify Full Disk Access and try narrowing your filters. Error: ${message}`;
        logger.error("search_messages failed", {
          query: input.query,
          chat_id: input.chat_id ?? null,
          participant: input.participant ?? null,
          from_unix_ms: input.from_unix_ms ?? null,
          to_unix_ms: input.to_unix_ms ?? null,
          error: message,
        });
        return { content: textContent(msg), isError: true };
      }
  }
);

  // connectors-compatible search tool (ChatGPT Pro, Deep Research, API connectors)
  server.registerTool(
    "search",
    {
      title: "Search Messages",
      description: "Full-text search across Messages.app history scoped to recent activity for MCP connectors.",
      inputSchema: {
        query: z.string().min(1).describe("Search query string."),
        chat_guid: z.string().min(1).optional().describe("Optional chat GUID to scope results."),
        participant: z.string().optional().describe("Optional handle (phone or email) to scope results."),
        days_back: z.number().int().min(1).max(365).optional().describe("How many days of history to include (default from env)."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum number of documents to return."),
      },
      outputSchema: {
        results: z.array(z.object({
          id: z.string(),
          title: z.string(),
          url: z.string().optional(),
          snippet: z.string(),
          metadata: z.object({
            chat_id: z.number().nullable(),
            from_me: z.boolean(),
            sender: z.string().nullable(),
            iso_utc: z.string().nullable(),
            iso_local: z.string().nullable(),
          }),
        })),
      },
    },
    async ({ query, chat_guid, participant, days_back, limit }) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        const payload = { results: [] };
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
        };
      }
      const effectiveDays = clampNumber(days_back ?? CONNECTOR_DEFAULT_DAYS_BACK, 1, 365);
      const resultLimit = clampNumber(limit ?? CONNECTOR_DEFAULT_LIMIT, 1, 50);
      const fromUnixMs = Date.now() - effectiveDays * 86400000;
      let chatId: number | undefined;
      if (chat_guid) {
        const resolvedChatId = await getChatIdByGuid(chat_guid);
        if (resolvedChatId == null) {
          const payload = { results: [] };
          return {
            content: textContent(JSON.stringify(payload)),
            structuredContent: payload,
          };
        }
        chatId = resolvedChatId;
      }
      try {
        const rows = await searchMessages({
          query: trimmedQuery,
          chatId: chatId ?? undefined,
          participant: participant ?? undefined,
          fromUnixMs,
          limit: resultLimit,
          includeAttachmentsMeta: true,
        });
        const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id: number }>);
        const chatLookup = new Map<number, number>();
        for (const row of rows as Array<EnrichedMessageRow & { chat_id: number }>) {
          chatLookup.set(row.message_rowid, row.chat_id);
        }
        const lowerQuery = trimmedQuery.toLowerCase();
        const results = normalized.map((msg) => {
          const text = msg.text ?? "";
          const idx = text.toLowerCase().indexOf(lowerQuery);
          let snippet = text;
          if (text) {
            const singleLine = text.replace(/\s+/g, " ").trim();
            if (idx >= 0) {
              const start = Math.max(0, idx - 80);
              const end = Math.min(singleLine.length, idx + lowerQuery.length + 80);
              snippet = `${start > 0 ? "…" : ""}${singleLine.slice(start, end)}${end < singleLine.length ? "…" : ""}`;
            } else {
              snippet = singleLine.length > 200 ? `${singleLine.slice(0, 197)}…` : singleLine;
            }
          } else if (msg.has_attachments && msg.attachment_hints?.length) {
            const hint = msg.attachment_hints[0];
            snippet = `Attachment: ${hint.name || hint.filename || hint.mime || "file"}`;
          } else {
            snippet = "(no text)";
          }
          const counterpart = msg.from_me ? "Me" : (msg.sender ? displayRecipient(msg.sender) : "Unknown sender");
          const timestamp = msg.iso_local ?? msg.iso_utc ?? null;
          const titleParts = [] as string[];
          if (counterpart) titleParts.push(counterpart);
          if (timestamp) titleParts.push(timestamp);
          if (!titleParts.length && snippet) {
            titleParts.push(snippet.slice(0, 80));
          }
          const baseUrl = CONNECTOR_BASE_URL || "mcp://messages-app-mcp";
          const resultId = `message:${msg.message_rowid}`;
          const resolvedChatId = msg.chat_id ?? chatLookup.get(msg.message_rowid);
          const metadataChatId = typeof resolvedChatId === "number" && Number.isFinite(resolvedChatId) ? resolvedChatId : null;
          return {
            id: resultId,
            title: titleParts.join(" • ") || `Message ${msg.message_rowid}`,
            url: `${baseUrl}/messages/${msg.message_rowid}`,
            snippet,
            metadata: {
              chat_id: metadataChatId,
              from_me: msg.from_me,
              sender: msg.sender ? displayRecipient(msg.sender) : null,
              iso_utc: msg.iso_utc,
              iso_local: msg.iso_local,
            },
          };
        });
        const payload = { results };
        logger.info("search tool", {
          query: trimmedQuery,
          chat_guid: chat_guid ?? null,
          participant: participant ?? null,
          days_back: effectiveDays,
          limit: resultLimit,
          result_count: results.length,
        });
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structuredPayload = { results: [] };
        const contentPayload = { ...structuredPayload, error: message };
        logger.error("search tool failed", {
          query: trimmedQuery,
          chat_guid: chat_guid ?? null,
          participant: participant ?? null,
          days_back: effectiveDays,
          limit: resultLimit,
          error: message,
        });
        return {
          content: textContent(JSON.stringify(contentPayload)),
          structuredContent: structuredPayload,
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Message",
      description: "Return full message content and optional context for MCP connectors.",
      inputSchema: {
        id: z.string().min(1).describe("Identifier from search results (e.g., message:12345)."),
        context_before: z.number().int().min(0).max(50).default(5).optional().describe("How many messages before to include in text."),
        context_after: z.number().int().min(0).max(50).default(5).optional().describe("How many messages after to include in text."),
      },
      outputSchema: {
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string().optional(),
        metadata: z.object({
          chat_id: z.number().nullable(),
          from_me: z.boolean(),
          sender: z.string().nullable(),
          iso_utc: z.string().nullable(),
          iso_local: z.string().nullable(),
          has_attachments: z.boolean(),
          context_before: z.number(),
          context_after: z.number(),
        }),
      },
    },
    async ({ id, context_before, context_after }) => {
      const normalizedId = String(id).trim();
      const before = clampNumber(context_before ?? 5, 0, 50);
      const after = clampNumber(context_after ?? 5, 0, 50);
      const buildErrorDocument = (errorMessage: string) => ({
        id: normalizedId,
        title: errorMessage,
        text: errorMessage,
        metadata: {
          chat_id: null,
          from_me: false,
          sender: null,
          iso_utc: null,
          iso_local: null,
          has_attachments: false,
          context_before: before,
          context_after: after,
        },
      });
      const numericMatch = normalizedId.match(/(\d+)$/);
      if (!numericMatch) {
        const payload = buildErrorDocument("Invalid message identifier");
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
          isError: true,
        };
      }
      const rowId = Number.parseInt(numericMatch[1], 10);
      if (!Number.isFinite(rowId) || rowId <= 0) {
        const payload = buildErrorDocument("Invalid message identifier");
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
          isError: true,
        };
      }
      const rows = await contextAroundMessage(rowId, before, after, true);
      if (!rows.length) {
        const payload = buildErrorDocument("Message not found");
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
          isError: true,
        };
      }
      const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>);
      const anchor = normalized.find((msg) => msg.message_rowid === rowId);
      if (!anchor) {
        const payload = buildErrorDocument("Message not found");
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
          isError: true,
        };
      }
      const formatLine = (msg: NormalizedMessage): string => {
        const when = msg.iso_local ?? msg.iso_utc ?? "";
        const speaker = msg.from_me ? "Me" : (msg.sender ? displayRecipient(msg.sender) : "Unknown");
        let body = msg.text?.trim().length ? msg.text.trim() : "";
        if (!body) {
          if (msg.has_attachments && msg.attachment_hints?.length) {
            const names = msg.attachment_hints.map((hint) => hint.name || hint.filename || hint.mime).filter(Boolean);
            body = `Attachment: ${names.join(", ") || "file"}`;
          } else {
            body = "(no text)";
          }
        }
        return [when, speaker, body].filter(Boolean).join(" | ");
      };
      const contextLines = normalized.map(formatLine);
      const baseUrl = CONNECTOR_BASE_URL || "mcp://messages-app-mcp";
      const document = {
        id: `message:${rowId}`,
        title: formatLine(anchor),
        text: contextLines.join("\n"),
        url: `${baseUrl}/messages/${rowId}`,
        metadata: {
          chat_id: anchor.chat_id ?? null,
          from_me: anchor.from_me,
          sender: anchor.sender ? displayRecipient(anchor.sender) : null,
          iso_utc: anchor.iso_utc,
          iso_local: anchor.iso_local,
          has_attachments: anchor.has_attachments,
          context_before: before,
          context_after: after,
        },
      };
      return {
        content: textContent(JSON.stringify(document)),
        structuredContent: document,
      };
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
        logger.warn("search_messages_safe rejected", {
          query: input.query,
          reason: "missing_scope_filters",
        });
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
        logger.info("search_messages_safe", {
          query: input.query,
          chat_id: input.chat_id ?? null,
          participant: input.participant ?? null,
          days_back: input.days_back ?? null,
          limit: input.limit,
          offset: input.offset,
          result_count: mapped.length,
        });
        return {
          content: textContent(JSON.stringify(mapped, null, 2)),
          structuredContent: { results: mapped },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const msg = `Failed to search messages safely. Error: ${message}`;
        logger.error("search_messages_safe failed", {
          query: input.query,
          chat_id: input.chat_id ?? null,
          participant: input.participant ?? null,
          days_back: input.days_back ?? null,
          error: message,
        });
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
  return server;
}

type HttpLaunchOptions = {
  mode: "http";
  port: number;
  host: string;
  enableSseFallback: boolean;
  corsOrigins: string[];
  dnsRebindingProtection: boolean;
  allowedHosts: string[];
};

type LaunchOptions = { mode: "stdio" } | HttpLaunchOptions;

function parseLaunchOptions(): LaunchOptions {
  const args = process.argv.slice(2);
  let mode: "stdio" | "http" = parseEnvBool("MESSAGES_MCP_HTTP", false) || process.env.MESSAGES_MCP_HTTP_PORT ? "http" : "stdio";
  let port = parsePort(process.env.MESSAGES_MCP_HTTP_PORT, 3000);
  let host = (process.env.MESSAGES_MCP_HTTP_HOST || "0.0.0.0").trim() || "0.0.0.0";
  let enableSseFallback = parseEnvBool("MESSAGES_MCP_HTTP_ENABLE_SSE", false);
  let dnsRebindingProtection = parseEnvBool("MESSAGES_MCP_HTTP_DNS_PROTECTION", false);
  let allowedHosts = parseCsv(process.env.MESSAGES_MCP_HTTP_ALLOWED_HOSTS);
  let corsOrigins = parseCsv(process.env.MESSAGES_MCP_HTTP_CORS_ORIGINS);
  if (!corsOrigins.length) corsOrigins = ["*"];

  const takeValue = (index: number): string | undefined => {
    const value = args[index + 1];
    return typeof value === "string" ? value : undefined;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      mode = "http";
      continue;
    }
    if (arg === "--stdio") {
      mode = "stdio";
      continue;
    }
    if (arg === "--port") {
      const value = takeValue(i);
      if (value) {
        port = parsePort(value, port);
        i++;
        mode = "http";
      }
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.split("=", 2)[1], port);
      mode = "http";
      continue;
    }
    if (arg === "--host") {
      const value = takeValue(i);
      if (value) {
        host = value;
        i++;
        mode = "http";
      }
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.split("=", 2)[1];
      mode = "http";
      continue;
    }
    if (arg === "--enable-sse" || arg === "--sse") {
      enableSseFallback = true;
      continue;
    }
    if (arg === "--disable-sse") {
      enableSseFallback = false;
      continue;
    }
    if (arg === "--cors-origin") {
      const value = takeValue(i);
      if (value) {
        corsOrigins = value === "*" ? ["*"] : [...new Set([...corsOrigins.filter((o) => o !== "*"), value])];
        i++;
      }
      continue;
    }
    if (arg.startsWith("--cors-origin=")) {
      const value = arg.split("=", 2)[1];
      corsOrigins = value === "*" ? ["*"] : [...new Set([...corsOrigins.filter((o) => o !== "*"), value])];
      continue;
    }
    if (arg === "--enable-dns-protection") {
      dnsRebindingProtection = true;
      continue;
    }
    if (arg === "--disable-dns-protection") {
      dnsRebindingProtection = false;
      continue;
    }
    if (arg === "--allowed-host") {
      const value = takeValue(i);
      if (value) {
        allowedHosts = [...new Set([...allowedHosts, value])];
        i++;
      }
      continue;
    }
    if (arg.startsWith("--allowed-host=")) {
      const value = arg.split("=", 2)[1];
      allowedHosts = [...new Set([...allowedHosts, value])];
      continue;
    }
  }

  if (mode === "http") {
    return {
      mode: "http",
      port,
      host,
      enableSseFallback,
      corsOrigins,
      dnsRebindingProtection,
      allowedHosts,
    };
  }

  return { mode: "stdio" };
}

async function runHttpServer(options: HttpLaunchOptions): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (options.corsOrigins.length) {
    const originSetting = options.corsOrigins.length === 1 && options.corsOrigins[0] === "*" ? "*" : options.corsOrigins;
    app.use(cors({
      origin: originSetting,
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "mcp-session-id"],
    }));
  }

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const legacySessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const server = createConfiguredServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          },
          enableDnsRebindingProtection: options.dnsRebindingProtection,
          allowedHosts: options.allowedHosts.length ? options.allowedHosts : undefined,
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            sessions.delete(id);
          }
          server.close().catch(() => {});
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
    } catch (error) {
      logger.error("HTTP transport error:", error);
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Internal Server Error",
        },
        id: null,
      });
    }
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  if (options.enableSseFallback) {
    app.get("/sse", async (_req: Request, res: Response) => {
      const transport = new SSEServerTransport("/messages", res);
      const server = createConfiguredServer();
      legacySessions.set(transport.sessionId, { transport, server });
      res.on("close", () => {
        legacySessions.delete(transport.sessionId);
        server.close().catch(() => {});
      });
      await server.connect(transport);
    });

    app.post("/messages", async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string | undefined;
      if (!sessionId || !legacySessions.has(sessionId)) {
        res.status(400).send("No transport found for sessionId");
        return;
      }
      const entry = legacySessions.get(sessionId)!;
      await entry.transport.handlePostMessage(req, res, req.body);
    });
  }

  return new Promise<void>((resolve) => {
    app.listen(options.port, options.host, () => {
      logger.info(`messages-app-mcp HTTP server listening on http://${options.host}:${options.port}`);
      if (options.enableSseFallback) {
        logger.info("Legacy SSE fallback enabled at /sse");
      }
      resolve();
    });
  });
}

async function runStdioServer(): Promise<void> {
  const server = createConfiguredServer();
  const transport = new StdioServerTransport();
  let settled = false;

  const waitForClose = new Promise<void>((resolve, reject) => {
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    server.server.onclose = resolveOnce;
    server.server.onerror = rejectOnce;
  });

  const shutdown = () => {
    server.close().catch(() => {});
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const wasPaused = typeof process.stdin.isPaused === "function" ? process.stdin.isPaused() : false;

  try {
    await server.connect(transport);
    if (!process.stdin.destroyed) {
      process.stdin.resume();
    }
    await waitForClose;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    if (wasPaused && !process.stdin.destroyed) {
      process.stdin.pause();
    }
  }
}

async function main() {
  const launch = parseLaunchOptions();
  logger.info("messages-app-mcp starting", { mode: launch.mode });
  if (launch.mode === "stdio") {
    await runStdioServer();
    return;
  }

  await runHttpServer(launch);
}

main().catch((err) => {
  logger.error("messages-app-mcp failed:", err);
  process.exit(1);
});
