#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import express, { type Request, type Response, type RequestHandler } from "express";
import cors from "cors";
import type { ConfigParams } from "express-openid-connect";
import * as expressOpenIdConnect from "express-openid-connect";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest, type LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  sendMessageAppleScript,
  sendAttachmentAppleScript,
  MESSAGES_FDA_HINT,
  type SendTarget,
  listMessagesAccounts,
  listMessagesParticipants,
  listMessagesFileTransfers,
  acceptMessagesFileTransfer,
  loginMessagesAccounts,
  logoutMessagesAccounts,
  type MessagesAccountInfo,
  type MessagesParticipantInfo,
  type MessagesFileTransferInfo,
  type MessagesFileTransferAcceptance,
} from "./utils/applescript.js";
import {
  listChats,
  getMessagesByChatId,
  getMessagesByParticipant,
  appleEpochToUnixMs,
  searchMessages,
  contextAroundMessage,
  getAttachmentsForMessages,
  getChatById,
  getChatIdByGuid,
  getChatIdByDisplayName,
  getChatIdByParticipant,
} from "./utils/sqlite.js";
import { buildSendFailurePayload, buildSendSuccessPayload } from "./utils/send-result.js";
import type { MessageLike, SendTargetDescriptor, SendResultPayload } from "./utils/send-result.js";
import { getVersionInfo, getVersionInfoSync } from "./utils/version.js";
import { runDoctor } from "./utils/doctor.js";
import { getLogger, getLogFilePath } from "./utils/logger.js";
import { normalizeMessageText, truncateForLog, estimateSegmentInfo } from "./utils/text-utils.js";
import type { SegmentInfo } from "./utils/text-utils.js";
import type { EnrichedMessageRow, AttachmentInfo } from "./utils/sqlite.js";
import { startLogViewer, type LogViewerHandle } from "./utils/log-viewer.js";
import { loadMessagesConfig, type MessagesConfig } from "./config.js";
import { refineSearchIntent } from "./utils/ai-search.js";

const { auth, requiresAuth } = expressOpenIdConnect;
const logger = getLogger();

type BasicLoggingLevel = Extract<LoggingLevel, "debug" | "info" | "warning" | "error">;

function normalizeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

function broadcastLog(level: BasicLoggingLevel, args: unknown[], servers: Iterable<McpServer>): void {
  switch (level) {
    case "debug":
      logger.debug(...args);
      break;
    case "info":
      logger.info(...args);
      break;
    case "warning":
      logger.warn(...args);
      break;
    case "error":
      logger.error(...args);
      break;
  }

  const payload = args.length === 0
    ? null
    : args.length === 1
      ? normalizeLogValue(args[0])
      : args.map((value) => normalizeLogValue(value));

  for (const server of servers) {
    void server
      .sendLoggingMessage({
        level,
        logger: "messages-app-mcp",
        data: payload,
      })
      .catch(() => {});
  }
}

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

type LogViewerSettings = {
  enabled: boolean;
  autoOpen: boolean;
  pollIntervalMs?: number;
};

const envLogViewerEnabledRaw = process.env.MESSAGES_MCP_LOG_VIEWER;
const envLogViewerAutoOpenRaw = process.env.MESSAGES_MCP_LOG_VIEWER_AUTO_OPEN;
const envLogViewerPollRaw = process.env.MESSAGES_MCP_LOG_VIEWER_POLL_INTERVAL;

const logViewerEnvOverrides = {
  enabled: envLogViewerEnabledRaw != null,
  autoOpen: envLogViewerAutoOpenRaw != null,
  pollInterval: envLogViewerPollRaw != null,
};

const logViewerSettings: LogViewerSettings = {
  enabled: logViewerEnvOverrides.enabled ? parseEnvBool("MESSAGES_MCP_LOG_VIEWER", true) : true,
  autoOpen: logViewerEnvOverrides.autoOpen ? parseEnvBool("MESSAGES_MCP_LOG_VIEWER_AUTO_OPEN", true) : true,
  pollIntervalMs: undefined,
};

if (logViewerEnvOverrides.pollInterval) {
  const parsedPoll = Number.parseInt(envLogViewerPollRaw ?? "", 10);
  if (Number.isFinite(parsedPoll)) {
    logViewerSettings.pollIntervalMs = clampNumber(parsedPoll, 250, 120000);
  }
}

let logViewerHandle: LogViewerHandle | null = null;
let logViewerInitPromise: Promise<LogViewerHandle | null> | null = null;

function applyConfigToLogViewer(config: MessagesConfig): void {
  const cfg = config.logViewer;
  if (!cfg) return;
  if (!logViewerEnvOverrides.enabled && typeof cfg.enabled === "boolean") {
    logViewerSettings.enabled = cfg.enabled;
  }
  if (!logViewerEnvOverrides.autoOpen && typeof cfg.autoOpen === "boolean") {
    logViewerSettings.autoOpen = cfg.autoOpen;
  }
  if (!logViewerEnvOverrides.pollInterval && typeof cfg.pollIntervalMs === "number" && Number.isFinite(cfg.pollIntervalMs)) {
    logViewerSettings.pollIntervalMs = clampNumber(Math.floor(cfg.pollIntervalMs), 250, 120000);
  }
}

async function ensureLogViewer(initialLabel = "logs"): Promise<void> {
  if (!logViewerSettings.enabled) return;
  if (!logViewerInitPromise) {
    logViewerInitPromise = (async () => {
      try {
        const logFilePath = getLogFilePath();
        const handle = await startLogViewer(logFilePath, {
          autoOpen: logViewerSettings.autoOpen,
          sessionLabel: initialLabel,
          pollIntervalMs: logViewerSettings.pollIntervalMs,
          onShutdownRequest: () => {
            logger.warn("log_viewer_shutdown_requested");
            process.nextTick(() => {
              try {
                process.kill(process.pid, "SIGINT");
              } catch {
                process.exit(0);
              }
            });
          },
        });
        logViewerHandle = handle;
        return handle;
      } catch (error) {
        logger.warn("log_viewer_start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();
  }

  const handle = await logViewerInitPromise;
  if (handle && logViewerSettings.autoOpen) {
    handle.open(initialLabel);
  }
}

function openLogViewer(): void {
  if (!logViewerSettings.enabled) return;
  if (!logViewerSettings.autoOpen) {
    ensureLogViewer().catch(() => {});
    return;
  }
  if (logViewerHandle) {
    logViewerHandle.open("logs");
    return;
  }
  ensureLogViewer("logs").catch(() => {});
}

const DEFAULT_SEGMENT_WARNING_THRESHOLD = 10;
const SEGMENT_WARNING_THRESHOLD = parseEnvInt(
  "MESSAGES_MCP_SEGMENT_WARNING",
  DEFAULT_SEGMENT_WARNING_THRESHOLD,
  0,
  100,
);

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

function formatHostForOrigin(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

function normalizeAllowedHosts(hosts: string[], port: number): string[] {
  const result = new Set<string>();
  for (const raw of hosts) {
    const value = raw.trim();
    if (!value) continue;

    // Already bracketed IPv6 literal
    if (value.startsWith("[") && value.includes("]")) {
      if (value.includes("]:")) {
        result.add(value);
      } else {
        result.add(`${value}:${port}`);
      }
      continue;
    }

    const lastColon = value.lastIndexOf(":");
    if (lastColon > 0) {
      const maybePort = value.slice(lastColon + 1);
      if (/^\d+$/.test(maybePort)) {
        result.add(value);
        continue;
      }
    }

    if (value.includes(":")) {
      // Bare IPv6 literal without brackets
      result.add(`[${value}]:${port}`);
    } else {
      result.add(`${value}:${port}`);
    }
  }
  return [...result];
}

function buildDefaultHostAllowlist(host: string, port: number): string[] {
  const set = new Set<string>();
  const addHost = (value: string) => {
    if (value) {
      set.add(value);
    }
  };
  if (host && host !== "0.0.0.0" && host !== "::" && host !== "::0") {
    addHost(`${host}:${port}`);
  } else {
    addHost(`127.0.0.1:${port}`);
    addHost(`localhost:${port}`);
    addHost(`[::1]:${port}`);
  }
  return [...set];
}

function buildDefaultCorsOrigins(host: string, port: number): string[] {
  const set = new Set<string>();
  const addOrigin = (scheme: string, hostname: string) => {
    if (!hostname) return;
    const formatted = formatHostForOrigin(hostname);
    set.add(`${scheme}://${formatted}:${port}`);
  };
  if (host && host !== "0.0.0.0" && host !== "::" && host !== "::0") {
    addOrigin("http", host);
    addOrigin("https", host);
  } else {
    addOrigin("http", "127.0.0.1");
    addOrigin("http", "localhost");
  }
  return [...set];
}

type OAuthRuntimeConfig = {
  authOptions: ConfigParams;
  trustProxy: number;
  protectHealth: boolean;
  sessionInfoPath: string | null;
};

function loadOAuthRuntimeConfig(): OAuthRuntimeConfig | null {
  const enabled = parseEnvBool("MESSAGES_MCP_HTTP_OIDC_ENABLED", false);
  if (!enabled) {
    return null;
  }

  const issuerBaseURL = process.env.MESSAGES_MCP_HTTP_OIDC_ISSUER_BASE_URL?.trim();
  const baseURL = process.env.MESSAGES_MCP_HTTP_OIDC_BASE_URL?.trim();
  const clientID = process.env.MESSAGES_MCP_HTTP_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.MESSAGES_MCP_HTTP_OIDC_CLIENT_SECRET?.trim();
  const sessionSecret = process.env.MESSAGES_MCP_HTTP_OIDC_SESSION_SECRET?.trim();
  const scope = process.env.MESSAGES_MCP_HTTP_OIDC_SCOPE?.trim() || "openid profile email";
  const audience = process.env.MESSAGES_MCP_HTTP_OIDC_AUDIENCE?.trim();
  const authRequired = parseEnvBool("MESSAGES_MCP_HTTP_OIDC_AUTH_REQUIRED", false);
  const idpLogout = parseEnvBool("MESSAGES_MCP_HTTP_OIDC_IDP_LOGOUT", false);
  const trustProxy = parseEnvInt("MESSAGES_MCP_HTTP_OIDC_TRUST_PROXY", 1, 0, 100);
  const protectHealth = parseEnvBool("MESSAGES_MCP_HTTP_OIDC_PROTECT_HEALTH", false);
  const rawSessionInfoPath = process.env.MESSAGES_MCP_HTTP_OIDC_SESSION_PATH;
  const sessionInfoPath = rawSessionInfoPath?.trim()
    ? rawSessionInfoPath.trim()
    : "/auth/session";

  const missing: string[] = [];
  if (!issuerBaseURL) missing.push("MESSAGES_MCP_HTTP_OIDC_ISSUER_BASE_URL");
  if (!baseURL) missing.push("MESSAGES_MCP_HTTP_OIDC_BASE_URL");
  if (!clientID) missing.push("MESSAGES_MCP_HTTP_OIDC_CLIENT_ID");
  if (!sessionSecret) missing.push("MESSAGES_MCP_HTTP_OIDC_SESSION_SECRET");

  if (missing.length) {
    throw new Error(
      `OAuth is enabled but required environment variables are missing: ${missing.join(", ")}`,
    );
  }

  const normalizedBaseURL = baseURL!.endsWith("/") ? baseURL!.slice(0, -1) : baseURL!;

  const authorizationParams: Record<string, string> = {
    response_type: "code",
    scope,
  };
  if (audience) {
    authorizationParams.audience = audience;
  }

  const authOptions: ConfigParams = {
    authRequired,
    issuerBaseURL: issuerBaseURL!,
    baseURL: normalizedBaseURL,
    clientID: clientID!,
    clientSecret: clientSecret || undefined,
    secret: sessionSecret!,
    idpLogout,
    authorizationParams,
  };

  return {
    authOptions,
    trustProxy,
    protectHealth,
    sessionInfoPath: sessionInfoPath && sessionInfoPath.length ? sessionInfoPath : null,
  };
}

const CONNECTOR_DEFAULT_DAYS_BACK = parseEnvInt("MESSAGES_MCP_CONNECTOR_DAYS_BACK", 30, 1, 365);
const CONNECTOR_DEFAULT_LIMIT = parseEnvInt("MESSAGES_MCP_CONNECTOR_SEARCH_LIMIT", 20, 1, 50);
const CONNECTOR_BASE_URL = (process.env.MESSAGES_MCP_CONNECTOR_BASE_URL || "").trim().replace(/\/+$/, "");
const HISTORY_BY_DAYS_MAX = parseEnvInt("MESSAGES_MCP_HISTORY_MAX_DAYS", 730, 1, 3650);
const INBOX_RESOURCE_URI = "messages://inbox";
const INBOX_RESOURCE_LIMIT = parseEnvInt("MESSAGES_MCP_INBOX_RESOURCE_LIMIT", 15, 5, 50);
const CONVERSATION_RESOURCE_TEMPLATE_URI = "messages://conversation/{selector}/{value}";
const CONVERSATION_RESOURCE_MESSAGE_LIMIT = parseEnvInt("MESSAGES_MCP_CONVERSATION_RESOURCE_LIMIT", 60, 10, 200);
const CONVERSATION_RESOURCE_LIST_LIMIT = parseEnvInt("MESSAGES_MCP_CONVERSATION_LIST_LIMIT", 20, 5, 100);

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
  let text = normalizeMessageText(row.text);
  if (text && text.trim().length > 0 && OBJECT_REPLACEMENT_ONLY.test(text.trim())) {
    text = null;
  }
  if (text && text.trim().length > 0) {
    textSource = "text";
  } else if (row.decoded_text && row.decoded_text.trim().length > 0) {
    text = normalizeMessageText(row.decoded_text);
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

function extractParticipantsList(serialized: string | null | undefined): string[] {
  if (!serialized) return [];
  return Array.from(
    new Set(
      serialized
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  );
}

type InboxConversationSummary = {
  chat_id: number;
  guid: string | null;
  display_name: string | null;
  participants: string[];
  unread_count: number;
  last_message_unix_ms: number | null;
  last_message_iso: string | null;
  latest_message: NormalizedMessage | null;
};

type InboxSnapshot = {
  generated_at: string;
  total_conversations: number;
  total_unread: number;
  conversations: InboxConversationSummary[];
};

async function buildInboxSnapshot(limit: number): Promise<InboxSnapshot> {
  const chats = await listChats(limit);
  const conversations = await Promise.all(
    chats.map(async (chat) => {
      const rows = await getMessagesByChatId(chat.chat_id, 1);
      const normalized = normalizeMessages(rows.map((row) => ({ ...row, chat_id: chat.chat_id })));
      const latest = normalized[0] ?? null;
      const lastUnix = appleEpochToUnixMs(chat.last_message_date);
      return {
        chat_id: chat.chat_id,
        guid: chat.guid ?? null,
        display_name: chat.display_name ?? null,
        participants: extractParticipantsList(chat.participants),
        unread_count: Number(chat.unread_count ?? 0),
        last_message_unix_ms: lastUnix,
        last_message_iso: toIsoUtc(lastUnix),
        latest_message: latest,
      } satisfies InboxConversationSummary;
    }),
  );
  const totalUnread = conversations.reduce((sum, entry) => sum + entry.unread_count, 0);
  return {
    generated_at: new Date().toISOString(),
    total_conversations: conversations.length,
    total_unread: totalUnread,
    conversations,
  };
}

type ConversationResourcePayload = {
  generated_at: string;
  selector: string;
  value: string;
  target: SendTargetDescriptor;
  chat: {
    chat_id: number;
    guid: string | null;
    display_name: string | null;
    participants: string[];
    unread_count: number;
    last_message_unix_ms: number | null;
    last_message_iso: string | null;
  };
  messages: NormalizedMessage[];
};

async function buildConversationResourcePayload(selector: string, rawValue: string): Promise<ConversationResourcePayload> {
  const normalizedSelector = selector.trim().toLowerCase();
  const decodedValue = decodeURIComponent(rawValue ?? "").trim();
  if (!decodedValue) {
    throw new Error("Conversation resource value must not be empty.");
  }

  let chatId: number | null = null;
  let candidateGuid: string | null = null;
  let candidateName: string | null = null;
  let candidateRecipient: string | null = null;

  switch (normalizedSelector) {
    case "chat-id": {
      const parsed = Number.parseInt(decodedValue, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid chat-id value: ${decodedValue}`);
      }
      chatId = parsed;
      break;
    }
    case "chat-guid": {
      chatId = await getChatIdByGuid(decodedValue);
      candidateGuid = decodedValue;
      break;
    }
    case "chat-name": {
      chatId = await getChatIdByDisplayName(decodedValue);
      candidateName = decodedValue;
      break;
    }
    case "participant": {
      chatId = await getChatIdByParticipant(decodedValue);
      candidateRecipient = decodedValue;
      break;
    }
    default:
      throw new Error(`Unsupported selector '${selector}'. Use chat-id, chat-guid, chat-name, or participant.`);
  }

  if (!chatId || !Number.isFinite(chatId) || chatId <= 0) {
    throw new Error(`Unable to resolve chat for selector '${selector}' and value '${decodedValue}'.`);
  }

  const chatRow = await getChatById(chatId);
  if (!chatRow) {
    throw new Error(`Chat ${chatId} not found.`);
  }

  const descriptor = buildTargetDescriptor({
    recipient: candidateRecipient ?? undefined,
    chat_guid: chatRow.guid ?? candidateGuid ?? undefined,
    chat_name: chatRow.display_name ?? candidateName ?? undefined,
  });

  const rows = await getMessagesByChatId(chatRow.chat_id, CONVERSATION_RESOURCE_MESSAGE_LIMIT);
  const normalized = normalizeMessages(rows.map((row) => ({ ...row, chat_id: chatRow.chat_id }))).sort((a, b) => {
    const aTime = typeof a.unix_ms === "number" ? a.unix_ms : 0;
    const bTime = typeof b.unix_ms === "number" ? b.unix_ms : 0;
    return aTime - bTime;
  });

  const lastUnix = appleEpochToUnixMs(chatRow.last_message_date);
  return {
    generated_at: new Date().toISOString(),
    selector: normalizedSelector,
    value: decodedValue,
    target: descriptor,
    chat: {
      chat_id: chatRow.chat_id,
      guid: chatRow.guid ?? null,
      display_name: chatRow.display_name ?? null,
      participants: extractParticipantsList(chatRow.participants),
      unread_count: Number(chatRow.unread_count ?? 0),
      last_message_unix_ms: lastUnix,
      last_message_iso: toIsoUtc(lastUnix),
    },
    messages: normalized,
  };
}

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
  submitted_text: z.string().optional(),
  submitted_text_length: z.number().int().nonnegative().optional(),
  submitted_segment_count: z.number().int().nonnegative().optional(),
  submitted_segment_encoding: z.enum(["gsm-7", "ucs-2"]).optional(),
  submitted_segment_unit_size: z.number().int().positive().optional(),
  submitted_segment_unit_count: z.number().int().nonnegative().optional(),
  payload_warning: z.string().optional(),
});

type SendOutputExtras = {
  attachment?: { file_path: string | null; file_label: string | null; caption: string | null };
  submittedText?: string;
  submittedLength?: number;
  segmentInfo?: SegmentInfo | null;
  payloadWarning?: string;
};

function applySendExtras(result: Record<string, unknown>, extra?: SendOutputExtras) {
  if (!extra) return result;
  if (extra.attachment) {
    result.attachment = extra.attachment;
  }
  if (typeof extra.submittedText === "string") {
    result.submitted_text = extra.submittedText;
  }
  if (typeof extra.submittedLength === "number") {
    result.submitted_text_length = extra.submittedLength;
  }
  if (extra.segmentInfo) {
    result.submitted_segment_count = extra.segmentInfo.segments;
    result.submitted_segment_encoding = extra.segmentInfo.encoding;
    result.submitted_segment_unit_size = extra.segmentInfo.segmentSize;
    result.submitted_segment_unit_count = extra.segmentInfo.unitCount;
  }
  if (extra.payloadWarning) {
    result.payload_warning = extra.payloadWarning;
  }
  return result;
}

function toStandardSendOutput(payload: SendResultPayload<NormalizedMessage>, extra?: SendOutputExtras) {
  if ((payload as any).status === "sent") {
    const p = payload as any;
    const base: Record<string, unknown> = {
      ok: true,
      summary: p.summary,
      target: p.target,
      chat_id: p.chat_id ?? null,
      latest_message: p.latest_message ?? null,
      recent_messages: p.recent_messages ?? [],
      lookup_error: p.lookup_error,
    };
    return applySendExtras(base, extra);
  }
  const p = payload as any;
  const base: Record<string, unknown> = {
    ok: false,
    summary: p.summary,
    target: p.target,
    chat_id: null,
    latest_message: null,
    recent_messages: [],
    error: p.error,
    lookup_error: p.lookup_error,
  };
  return applySendExtras(base, extra);
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

const CONNECTOR_MANIFEST_VERSION = "2025-06-18";
const CONNECTOR_DEFAULT_CONTACT = process.env.MESSAGES_MCP_CONNECTOR_CONTACT?.trim() || "support@genericservice.app";
const CONNECTOR_DEFAULT_DOCS_URL =
  process.env.MESSAGES_MCP_CONNECTOR_DOCS_URL?.trim() || "https://github.com/Baphomet480/messages-app-mcp";
const CONNECTOR_DEFAULT_PRIVACY_URL =
  process.env.MESSAGES_MCP_CONNECTOR_PRIVACY_URL?.trim() || `${CONNECTOR_DEFAULT_DOCS_URL}#privacy`;
const CONNECTOR_DEFAULT_TOS_URL = process.env.MESSAGES_MCP_CONNECTOR_TOS_URL?.trim() || `${CONNECTOR_DEFAULT_DOCS_URL}#terms`;
const CONNECTOR_MANIFEST_CAPABILITIES = {
  tools: {
    listChanged: true,
  },
} as const;
const CONNECTOR_MANIFEST_TOOLS: Array<{ name: string; description: string }> = [
  {
    name: "search",
    description: "Connector-compatible full-text search across Messages.app history.",
  },
  {
    name: "fetch",
    description: "Fetch an individual message and optional conversational context by id.",
  },
];

type ToolResourceLink = {
  type: "resource_link";
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
};

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
      capabilities: {
        logging: {},
      },
    }
  );

  const logToClients = (level: BasicLoggingLevel, args: unknown[]): void => {
    broadcastLog(level, args, [server]);
  };

  const mcpLog = {
    debug: (...args: unknown[]) => logToClients("debug", args),
    info: (...args: unknown[]) => logToClients("info", args),
    warn: (...args: unknown[]) => logToClients("warning", args),
    error: (...args: unknown[]) => logToClients("error", args),
  } as const;

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

  server.registerTool(
    "send_text",
    {
      title: "Send Message",
      description: "Send an SMS, RCS, or iMessage via Messages.app to a phone number, chat GUID, or named chat.",
      inputSchema: sendTextInputSchema,
      outputSchema: sendStandardOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ recipient, chat_guid, chat_name, text }) => {
      const base = { recipient, chat_guid, chat_name };
      if (READ_ONLY_MODE) {
        if (!hasTarget(base)) {
          return {
            content: textContent("Missing target. Provide recipient, chat_guid, or chat_name."),
            isError: true,
          };
        }
        const targetDescriptor = buildTargetDescriptor(base);
        const failure = buildSendFailurePayload(targetDescriptor, "Read-only mode is enabled.");
        mcpLog.warn("send_text skipped in read-only mode", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
        });
        const std = toStandardSendOutput(failure);
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
      }

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
        const segmentInfo = estimateSegmentInfo(text);
        const textLength = Array.from(text).length;
        let payloadWarning: string | undefined;
        if (SEGMENT_WARNING_THRESHOLD > 0 && segmentInfo.segments > SEGMENT_WARNING_THRESHOLD) {
          const unitLabel = segmentInfo.encoding === "gsm-7" ? "GSM-7 units" : "code points";
          payloadWarning = `Text spans ${segmentInfo.segments} segments (${segmentInfo.unitCount} ${unitLabel}); consider splitting to stay within ${SEGMENT_WARNING_THRESHOLD} segments for reliable delivery.`;
        }
        const std = toStandardSendOutput(payload, {
          submittedText: text,
          submittedLength: textLength,
          segmentInfo,
          payloadWarning,
        });
        mcpLog.info("send_text success", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
          chat_id: chatId ?? null,
          message_preview: truncateForLog(text),
          latest_message_id: payload.latest_message?.message_rowid ?? null,
          lookup_error: lookupError ?? null,
          submitted_segment_count: segmentInfo.segments,
          submitted_segment_encoding: segmentInfo.encoding,
          payload_warning: payloadWarning ?? null,
        });
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std };
      } catch (e) {
        const reason = cleanOsaError(e);
        const failure = buildSendFailurePayload(targetDescriptor, reason);
        const segmentInfo = estimateSegmentInfo(text);
        const textLength = Array.from(text).length;
        let payloadWarning: string | undefined;
        if (SEGMENT_WARNING_THRESHOLD > 0 && segmentInfo.segments > SEGMENT_WARNING_THRESHOLD) {
          const unitLabel = segmentInfo.encoding === "gsm-7" ? "GSM-7 units" : "code points";
          payloadWarning = `Text spans ${segmentInfo.segments} segments (${segmentInfo.unitCount} ${unitLabel}); consider splitting to stay within ${SEGMENT_WARNING_THRESHOLD} segments for reliable delivery.`;
        }
        const std = toStandardSendOutput(failure, {
          submittedText: text,
          submittedLength: textLength,
          segmentInfo,
          payloadWarning,
        });
        mcpLog.error("send_text failed", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
          error: reason,
          message_preview: truncateForLog(text),
          submitted_segment_count: segmentInfo.segments,
          submitted_segment_encoding: segmentInfo.encoding,
          payload_warning: payloadWarning ?? null,
        });
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
      }
    }
  );

  server.registerTool(
    "send_attachment",
    {
      title: "Send Attachment",
      description: "Send an attachment via Messages.app to a recipient or existing chat.",
      inputSchema: sendAttachmentInputSchema,
      outputSchema: sendStandardOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ recipient, chat_guid, chat_name, file_path, caption }) => {
      const base = { recipient, chat_guid, chat_name };
      const trimmedPath = file_path?.trim?.() ?? file_path;

      if (READ_ONLY_MODE) {
        if (!hasTarget(base)) {
          return {
            content: textContent("Missing target. Provide recipient, chat_guid, or chat_name."),
            isError: true,
          };
        }
        const targetDescriptor = buildTargetDescriptor(base);
        const failure = buildSendFailurePayload(targetDescriptor, "Read-only mode is enabled.");
        mcpLog.warn("send_attachment skipped in read-only mode", {
          target: targetDescriptor.display,
          recipient: maskRecipient(recipient ?? ""),
        });
        const std = toStandardSendOutput(failure);
        return { content: textContent(JSON.stringify(std, null, 2)), structuredContent: std, isError: true };
      }

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
        mcpLog.info("send_attachment success", {
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
        mcpLog.error("send_attachment failed", {
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

  server.registerTool(
    "applescript_handler_template",
    {
      title: "AppleScript Handler Template",
      description: "Return a starter AppleScript for Messages event handlers (message received/sent, file transfer).",
      inputSchema: { minimal: z.boolean().optional().describe("Set true to omit inline comments.") },
      outputSchema: { script: z.string() },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
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
        rcs_available: z.boolean(),
        sqlite_access: z.boolean(),
        db_path: z.string(),
        notes: z.array(z.string()),
        package_name: z.string(),
        package_version: z.string(),
        git_commit: z.string().nullable(),
        git_commit_short: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
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

  server.registerTool(
    "messaging_capabilities",
    {
      title: "Messaging Capabilities",
      description: "Summarize delivery channels and send tools exposed by messages-app-mcp.",
      outputSchema: {
        summary: z.string(),
        channels: z.array(
          z.object({
            name: z.string(),
            delivery: z.string(),
            notes: z.string(),
          })
        ),
        tools: z.array(
          z.object({
            tool: z.string(),
            purpose: z.string(),
            inputs: z.array(z.string()),
          })
        ),
        requirements: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const payload = {
        summary: "messages-app-mcp can originate SMS, RCS, and iMessage conversations and fetch recent context via Messages.app.",
        channels: [
          {
            name: "SMS",
            delivery: "Green bubble texts routed through the paired iPhone or carrier.",
            notes: "Requires Text Message Forwarding or cellular Mac capability; segment counts use GSM-7 when possible.",
          },
          {
            name: "RCS",
            delivery: "Rich Communication Services via the Apple/Google hub available on Sequoia and newer.",
            notes: "Availability depends on signed-in RCS account; diagnostics surface support through the doctor tool.",
          },
          {
            name: "iMessage",
            delivery: "Apple’s blue bubble service over data with read receipts and attachments.",
            notes: "Requires a signed-in Apple ID within Messages.app on this host.",
          },
        ],
        tools: [
          {
            tool: "send_text",
            purpose: "Send Message — originate or continue a thread with text only.",
            inputs: ["recipient", "chat_guid", "chat_name", "text"],
          },
          {
            tool: "send_attachment",
            purpose: "Send Attachment — deliver a file with optional caption.",
            inputs: ["recipient", "chat_guid", "chat_name", "file_path", "caption"],
          },
          {
            tool: "recent_messages_by_participant",
            purpose: "Fetch a quick history for a single handle to confirm context before sending.",
            inputs: ["participant", "limit"],
          },
          {
            tool: "list_chats",
            purpose: "Enumerate active threads to select the correct conversation prior to sending.",
            inputs: ["limit", "participant", "updated_after_unix_ms", "unread_only"],
          },
        ],
        requirements: [
          "macOS with Messages.app signed into the desired services",
          "Terminal process granted Full Disk Access to read chat.db",
          "Outgoing sends disabled when MESSAGES_MCP_READONLY=true",
        ],
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
      title: "List Chats",
      description: "List recent chats from Messages.db with participants and last-activity.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Maximum chats to return (defaults to 50)."),
        participant: z
          .string()
          .optional()
          .describe("Optional participant handle fragment to scope chats."),
        updated_after_unix_ms: z
          .number()
          .int()
          .optional()
          .describe("Only include chats updated after this Unix timestamp in milliseconds."),
        unread_only: z
          .boolean()
          .optional()
          .describe("When true, restrict results to chats with unread messages."),
      },
      outputSchema: {
        chats: z.array(
          z.object({
            chat_id: z.number(),
            guid: z.string(),
            display_name: z.string().nullable(),
            participants: z.array(z.string()),
            last_message_unix_ms: z.number().nullable(),
            last_message_iso_utc: z.string().nullable(),
            last_message_iso_local: z.string().nullable(),
            unread_count: z.number().nullable(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
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
      title: "Get Messages",
      description: "Get recent messages by chat_id or participant handle (phone/email).",
      inputSchema: {
        chat_id: z
          .number()
          .int()
          .optional()
          .describe("Numeric chat identifier from list_chats."),
        participant: z
          .string()
          .optional()
          .describe("Phone number or email handle to scope the query."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Maximum number of messages to return (defaults to 50)."),
        context_anchor_rowid: z
          .number()
          .int()
          .optional()
          .describe("Anchor message_rowid for contextual expansion."),
        context_before: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(10)
          .describe("Messages to include before the anchor (0-200)."),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(10)
          .describe("Messages to include after the anchor (0-200)."),
        context_include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata in contextual results."),
      },
      outputSchema: {
        messages: z.array(normalizedMessageSchema),
        context: z
          .object({
            anchor_rowid: z.number(),
            before: z.number(),
            after: z.number(),
            include_attachments_meta: z.boolean(),
            messages: z.array(normalizedMessageSchema),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({
      chat_id,
      participant,
      limit,
      context_anchor_rowid,
      context_before,
      context_after,
      context_include_attachments_meta,
    }) => {
      if (chat_id == null && !participant) {
        return { content: textContent("Provide either chat_id or participant."), isError: true };
      }
      try {
        const rows =
          chat_id != null
            ? await getMessagesByChatId(chat_id, limit)
            : await getMessagesByParticipant(participant!, limit);
        const mapped = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort(
          (a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0),
        );
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
          const ctxRows = await contextAroundMessage(
            context_anchor_rowid,
            context_before,
            context_after,
            !!context_include_attachments_meta,
          );
          const ctxMessages = normalizeMessages(ctxRows as Array<EnrichedMessageRow & { chat_id?: number }>).sort(
            (a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0),
          );
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

  server.registerTool(
    "recent_messages_by_participant",
    {
      title: "Recent Messages By Participant",
      description: "Return the most recent normalized messages for a participant handle (phone/email).",
      inputSchema: {
        participant: z
          .string()
          .min(1)
          .describe("Handle (phone or email) whose history should be returned."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Maximum messages to return (defaults to 50)."),
        include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata in the response."),
      },
      outputSchema: {
        messages: z.array(normalizedMessageSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ participant, limit, include_attachments_meta }) => {
      try {
        const rows = await getMessagesByParticipant(participant, limit, {
          includeAttachmentsMeta: !!include_attachments_meta,
        });
        const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>);
        mcpLog.info("recent_messages_by_participant", {
          participant,
          masked_participant: maskRecipient(participant),
          limit,
          result_count: normalized.length,
        });
        return {
          content: textContent(JSON.stringify(normalized, null, 2)),
          structuredContent: { messages: normalized },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const msg = `Failed to retrieve messages for participant. Error: ${message}`;
        mcpLog.error("recent_messages_by_participant failed", {
          participant,
          masked_participant: maskRecipient(participant),
          error: message,
        });
        return { content: textContent(msg), isError: true };
      }
    }
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List Messages accounts with service type, connection status, and enablement state.",
      outputSchema: {
        accounts: z.array(
          z.object({
            id: z.string(),
            service_type: z.string(),
            description: z.string(),
            connection_status: z.string(),
            enabled: z.boolean(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const accounts = await listMessagesAccounts();
        mcpLog.info("list_accounts", { account_count: accounts.length, services: accounts.map((a) => a.service_type) });
        const payload = { accounts } satisfies { accounts: MessagesAccountInfo[] };
        return {
          content: textContent(JSON.stringify(payload, null, 2)),
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("list_accounts_failed", { error: message });
        return { content: textContent(`Failed to list Messages accounts. Error: ${message}`), isError: true };
      }
    }
  );

  server.registerTool(
    "list_participants",
    {
      title: "List Participants",
      description: "List known participants from Messages with optional substring filtering.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against handle and contact names."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum participants to return (defaults to 250)."),
      },
      outputSchema: {
        participants: z.array(
          z.object({
            id: z.string(),
            handle: z.string(),
            name: z.string(),
            first_name: z.string(),
            last_name: z.string(),
            full_name: z.string(),
            account_service_type: z.string(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ filter, limit }) => {
      try {
        const participants = await listMessagesParticipants(filter);
        const trimmed =
          typeof limit === "number" && limit > 0 ? participants.slice(0, limit) : participants.slice(0, 250);
        mcpLog.info("list_participants", {
          filter: filter ?? null,
          limit: limit ?? null,
          total_count: participants.length,
          returned_count: trimmed.length,
        });
        const payload = { participants: trimmed } satisfies { participants: MessagesParticipantInfo[] };
        return {
          content: textContent(JSON.stringify(payload, null, 2)),
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("list_participants_failed", { error: message, filter: filter ?? null });
        return { content: textContent(`Failed to list Messages participants. Error: ${message}`), isError: true };
      }
    }
  );

  server.registerTool(
    "login_accounts",
    {
      title: "Login Accounts",
      description: "Trigger Messages to log in all configured accounts.",
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        await loginMessagesAccounts();
        const message = "Login command sent to Messages.";
        mcpLog.info("login_accounts_success");
        return { content: textContent(message), structuredContent: { ok: true, message } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("login_accounts_failed", { error: message });
        return {
          content: textContent(`Failed to log in Messages accounts. Error: ${message}`),
          structuredContent: { ok: false, message },
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "logout_accounts",
    {
      title: "Logout Accounts",
      description: "Trigger Messages to log out all configured accounts.",
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        await logoutMessagesAccounts();
        const message = "Logout command sent to Messages.";
        mcpLog.info("logout_accounts_success");
        return { content: textContent(message), structuredContent: { ok: true, message } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("logout_accounts_failed", { error: message });
        return {
          content: textContent(`Failed to log out Messages accounts. Error: ${message}`),
          structuredContent: { ok: false, message },
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_file_transfers",
    {
      title: "List File Transfers",
      description: "List file transfers that Messages is currently processing.",
      inputSchema: {
        include_finished: z
          .boolean()
          .optional()
          .describe("Include completed transfers (defaults to false)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum number of transfers to return."),
      },
      outputSchema: {
        transfers: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            direction: z.string(),
            transfer_status: z.string(),
            file_path: z.string(),
            file_size: z.number().nullable(),
            file_progress: z.number().nullable(),
            started_unix: z.number().nullable(),
            started_iso: z.string(),
            account_service_type: z.string(),
            account_id: z.string(),
            participant_handle: z.string(),
            participant_name: z.string(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ include_finished, limit }) => {
      try {
        const transfers = await listMessagesFileTransfers({ includeFinished: include_finished, limit: limit ?? 0 });
        mcpLog.info("list_file_transfers", {
          transfer_count: transfers.length,
          include_finished: !!include_finished,
          limit: limit ?? null,
          directions: Array.from(new Set(transfers.map((t) => t.direction))).filter(Boolean),
        });
        const payload = { transfers } satisfies { transfers: MessagesFileTransferInfo[] };
        return {
          content: textContent(JSON.stringify(payload, null, 2)),
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("list_file_transfers_failed", {
          error: message,
          include_finished: !!include_finished,
          limit: limit ?? null,
        });
        return { content: textContent(`Failed to list Messages file transfers. Error: ${message}`), isError: true };
      }
    }
  );

  server.registerTool(
    "accept_file_transfer",
    {
      title: "Accept File Transfer",
      description: "Accept a pending Messages file transfer by id and return updated metadata.",
      inputSchema: {
        id: z.string().min(1).describe("File transfer id (from list_file_transfers)."),
      },
      outputSchema: {
        transfer: z.object({
          id: z.string(),
          name: z.string(),
          direction: z.string(),
          transfer_status: z.string(),
          file_path: z.string(),
          file_size: z.number().nullable(),
          file_progress: z.number().nullable(),
          started_unix: z.number().nullable(),
          started_iso: z.string(),
          account_service_type: z.string(),
          account_id: z.string(),
          participant_handle: z.string(),
          participant_name: z.string(),
          accepted: z.boolean(),
          error: z.string(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const acceptance = await acceptMessagesFileTransfer(id);
        mcpLog.info("accept_file_transfer", {
          id,
          accepted: acceptance.accepted,
          transfer_status: acceptance.transfer_status,
          account_service_type: acceptance.account_service_type,
          participant_handle: maskRecipient(acceptance.participant_handle ?? ""),
          error: acceptance.error || null,
        });
        const payload = { transfer: acceptance } satisfies { transfer: MessagesFileTransferAcceptance };
        return {
          content: textContent(JSON.stringify(payload, null, 2)),
          structuredContent: payload,
          isError: acceptance.accepted ? undefined : true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("accept_file_transfer_failed", { id, error: message });
        return { content: textContent(`Failed to accept file transfer ${id}. Error: ${message}`), isError: true };
      }
    }
  );

  // search_messages tool
  server.registerTool(
    "search_messages",
    {
      title: "Search Messages (Scoped)",
      description:
        "Search or filter conversation history by text with optional chat/participant scope and explicit time bounds.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search text to match within message bodies."),
        chat_id: z
          .number()
          .int()
          .optional()
          .describe("Scope search to this chat_id."),
        participant: z
          .string()
          .optional()
          .describe("Scope search to messages involving this handle."),
        from_unix_ms: z
          .number()
          .int()
          .optional()
          .describe("Lower bound Unix timestamp (ms) for message time."),
        to_unix_ms: z
          .number()
          .int()
          .optional()
          .describe("Upper bound Unix timestamp (ms) for message time."),
        from_me: z
          .boolean()
          .optional()
          .describe("Filter to messages sent by the user when true."),
        has_attachments: z
          .boolean()
          .optional()
          .describe("Filter to messages with attachments when true."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Maximum results to return (defaults to 50)."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Result offset for pagination."),
        include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata in results when true."),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (input.chat_id == null && !input.participant && input.from_unix_ms == null && input.to_unix_ms == null) {
        mcpLog.warn("search_messages rejected", {
          query: input.query,
          reason: "missing_scope_filters",
        });
        return {
          content: textContent(
            "Provide chat_id, participant, or from/to unix filters when searching to avoid full-database scans.",
          ),
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
        mcpLog.info("search_messages", {
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
          mcpLog.warn("search_messages rejected", {
            query: input.query,
            reason: message,
          });
          return {
            content: textContent(
              "Provide chat_id, participant, or from/to unix filters when searching to avoid full-database scans.",
            ),
            isError: true,
          };
        }
        const msg = `Failed to search messages. Verify Full Disk Access and try narrowing your filters. Error: ${message}`;
        mcpLog.error("search_messages failed", {
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

  server.registerTool(
    "history_by_days",
    {
      title: "History By Days",
      description:
        "Fetch recent messages from a chat or participant over a fixed number of days without providing a text query.",
      inputSchema: {
        chat_id: z
          .number()
          .int()
          .optional()
          .describe("Numeric chat identifier from list_chats."),
        participant: z
          .string()
          .optional()
          .describe("Handle (phone/email) whose merged conversation should be fetched."),
        days_back: z
          .number()
          .int()
          .min(1)
          .max(HISTORY_BY_DAYS_MAX)
          .default(30)
          .describe("How many days of history to include (default 30)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe("Maximum number of messages to return (default 100)."),
        include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata for returned messages."),
      },
      outputSchema: {
        summary: z.string(),
        results: z.array(normalizedMessageSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ chat_id, participant, days_back, limit, include_attachments_meta }) => {
      if (chat_id == null && !participant) {
        return {
          content: textContent("Provide chat_id or participant."),
          isError: true,
        };
      }
      const effectiveDays = clampNumber(days_back ?? 30, 1, HISTORY_BY_DAYS_MAX);
      const effectiveLimit = clampNumber(limit ?? 100, 1, 500);
      const fromUnix = Date.now() - effectiveDays * 86_400_000;
      try {
        const rows = await searchMessages({
          query: "",
          chatId: chat_id ?? undefined,
          participant: participant ?? undefined,
          fromUnixMs: fromUnix,
          limit: effectiveLimit,
          includeAttachmentsMeta: !!include_attachments_meta,
        });
        const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id: number }>).sort(
          (a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0),
        );
        const summaryParts = [`${normalized.length} messages`, `days_back=${effectiveDays}`, `limit=${effectiveLimit}`];
        if (chat_id != null) summaryParts.push(`chat_id=${chat_id}`);
        if (participant) summaryParts.push(`participant=${participant}`);
        const summary = summaryParts.join(" | ");
        mcpLog.info("history_by_days", {
          chat_id: chat_id ?? null,
          participant: participant ?? null,
          days_back: effectiveDays,
          limit: effectiveLimit,
          result_count: normalized.length,
        });
        const structuredContent = {
          summary,
          results: normalized,
        } as const;
        return {
          content: textContent(JSON.stringify(structuredContent, null, 2)),
          structuredContent,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mcpLog.error("history_by_days_failed", {
          chat_id: chat_id ?? null,
          participant: participant ?? null,
          days_back: effectiveDays,
          error: message,
        });
        return {
          content: textContent(`Failed to fetch history by days. Error: ${message}`),
          isError: true,
        };
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
        days_back: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("How many days of history to include (default from env)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of documents to return."),
      },
      outputSchema: {
        results: z.array(
          z.object({
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
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, chat_guid, participant, days_back, limit }) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        const payload = { results: [] } as const;
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
        };
      }

      let refinedQuery = trimmedQuery;
      let resolvedParticipant = participant;
      let resolvedChatGuid = chat_guid;
      let resolvedDaysBack = days_back;
      let resolvedLimit = limit;
      let aiAssisted = false;

      try {
        const refinement = await refineSearchIntent(trimmedQuery, {
          defaultDays: days_back ?? CONNECTOR_DEFAULT_DAYS_BACK,
          defaultLimit: limit ?? CONNECTOR_DEFAULT_LIMIT,
        });
        if (refinement) {
          const updatedQuery = refinement.query?.trim();
          if (updatedQuery && updatedQuery.length > 0 && updatedQuery !== refinedQuery) {
            refinedQuery = updatedQuery;
            aiAssisted = true;
          }
          const participantProvided = typeof participant === "string" && participant.trim().length > 0;
          if (!participantProvided) {
            const aiParticipant = refinement.participant?.trim();
            if (aiParticipant && aiParticipant.length > 0) {
              resolvedParticipant = aiParticipant;
              aiAssisted = true;
            }
          }
          const chatGuidProvided = typeof chat_guid === "string" && chat_guid.trim().length > 0;
          if (!chatGuidProvided) {
            const aiChatGuid = refinement.chat_guid?.trim();
            if (aiChatGuid && aiChatGuid.length > 0) {
              resolvedChatGuid = aiChatGuid;
              aiAssisted = true;
            }
          }
          if (resolvedDaysBack == null && refinement.days_back != null) {
            resolvedDaysBack = refinement.days_back;
            aiAssisted = true;
          }
          if (resolvedLimit == null && refinement.limit != null) {
            resolvedLimit = refinement.limit;
            aiAssisted = true;
          }
        }
      } catch (error) {
        mcpLog.debug("AI search refinement failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const effectiveDays = clampNumber(resolvedDaysBack ?? CONNECTOR_DEFAULT_DAYS_BACK, 1, 365);
      const resultLimit = clampNumber(resolvedLimit ?? CONNECTOR_DEFAULT_LIMIT, 1, 50);
      const fromUnixMs = Date.now() - effectiveDays * 86400000;

      let chatId: number | undefined;
      if (resolvedChatGuid) {
        const resolvedChatId = await getChatIdByGuid(resolvedChatGuid);
        if (resolvedChatId == null) {
          const payload = { results: [] } as const;
          return {
            content: textContent(JSON.stringify(payload)),
            structuredContent: payload,
          };
        }
        chatId = resolvedChatId;
      }

      try {
        const rows = await searchMessages({
          query: refinedQuery,
          chatId: chatId ?? undefined,
          participant: resolvedParticipant ?? undefined,
          fromUnixMs,
          limit: resultLimit,
          includeAttachmentsMeta: true,
        });
        const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id: number }>);
        const chatLookup = new Map<number, number>();
        for (const row of rows as Array<EnrichedMessageRow & { chat_id: number }>) {
          chatLookup.set(row.message_rowid, row.chat_id);
        }
        const lowerQuery = refinedQuery.toLowerCase();
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
          const counterpart = msg.from_me ? "Me" : msg.sender ? displayRecipient(msg.sender) : "Unknown sender";
          const timestamp = msg.iso_local ?? msg.iso_utc ?? null;
          const titleParts: string[] = [];
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
        mcpLog.info("search tool", {
          query: refinedQuery,
          chat_guid: resolvedChatGuid ?? null,
          participant: resolvedParticipant ?? null,
          days_back: effectiveDays,
          limit: resultLimit,
          result_count: results.length,
          ai_assisted: aiAssisted,
        });
        return {
          content: textContent(JSON.stringify(payload)),
          structuredContent: payload,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const structuredPayload = { results: [] } as const;
        const contentPayload = { ...structuredPayload, error: message };
        mcpLog.error("search tool failed", {
          query: refinedQuery,
          chat_guid: resolvedChatGuid ?? null,
          participant: resolvedParticipant ?? null,
          days_back: effectiveDays,
          limit: resultLimit,
          error: message,
          ai_assisted: aiAssisted,
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
        context_before: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(5)
          .optional()
          .describe("How many messages before to include in text."),
        context_after: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(5)
          .optional()
          .describe("How many messages after to include in text."),
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
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
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
      const resourceLinks: ToolResourceLink[] =
        anchor.attachment_hints
          ?.map((hint, index) => {
            if (!hint.resolved_path) {
              return null;
            }
            const resolved = hint.resolved_path.startsWith("file://")
              ? hint.resolved_path
              : `file://${hint.resolved_path}`;
            const fileLabel = hint.filename || basename(hint.resolved_path);
            const candidateName = hint.name || fileLabel || hint.mime || `attachment-${index + 1}`;
            const name = candidateName || `attachment-${index + 1}`;
            const description = fileLabel || hint.mime || "Message attachment";
            const link: ToolResourceLink = {
              type: "resource_link",
              uri: resolved,
              name,
              description,
              mimeType: hint.mime ?? undefined,
            };
            return link;
          })
          .filter((link): link is ToolResourceLink => Boolean(link)) ?? [];
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
        resourceLinks: resourceLinks.length ? resourceLinks : undefined,
      };
    }
  );

  // context_around_message tool
  server.registerTool(
    "context_around_message",
    {
      title: "Context Around Message",
      description: "Fetch N messages before and after a message_rowid within its chat (ordered by time).",
      inputSchema: {
        message_rowid: z
          .number()
          .int()
          .describe("Anchor message_rowid to center the window on."),
        before: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(10)
          .describe("Number of messages before the anchor to include."),
        after: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(10)
          .describe("Number of messages after the anchor to include."),
        include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata in the returned window."),
      },
      outputSchema: {
        messages: z.array(normalizedMessageSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_rowid, before, after, include_attachments_meta }) => {
      const rows = await contextAroundMessage(message_rowid, before, after, !!include_attachments_meta);
      const mapped = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort(
        (a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0),
      );
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
      title: "Get Attachments",
      description:
        "Fetch attachment metadata and resolved file paths for specific message row IDs (per-message cap enforced).",
      inputSchema: {
        message_rowids: z
          .array(z.number().int())
          .min(1)
          .max(50)
          .describe("List of message_rowid values to inspect for attachments."),
        per_message_cap: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Maximum attachments to return per message."),
      },
      outputSchema: {
        attachments: z.array(attachmentRecordSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
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
      title: "Search Messages Safe",
      description:
        "Search or fetch recent conversation history with mandatory scope (chat, participant, or days_back ≤ 365).",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search text to match within conversations."),
        chat_id: z
          .number()
          .int()
          .optional()
          .describe("Scope search to this chat identifier."),
        participant: z
          .string()
          .optional()
          .describe("Handle (phone/email) to scope search to."),
        days_back: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe("When no chat or participant is given, limit search to this many days."),
        from_me: z
          .boolean()
          .optional()
          .describe("Filter to messages authored by the user."),
        has_attachments: z
          .boolean()
          .optional()
          .describe("Filter to messages that include attachments."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum number of results to return (defaults to 50)."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Result offset for pagination."),
        include_attachments_meta: z
          .boolean()
          .optional()
          .describe("Include attachment metadata in search results when true."),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (input.chat_id == null && !input.participant && !(input.days_back && input.days_back > 0)) {
        mcpLog.warn("search_messages_safe rejected", {
          query: input.query,
          reason: "missing_scope_filters",
        });
        return { content: textContent("Provide chat_id, participant, or days_back."), isError: true };
      }
      const now = Date.now();
      const from = input.chat_id != null || input.participant ? undefined : now - (input.days_back ?? 30) * 86400000;
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
        mcpLog.info("search_messages_safe", {
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
        mcpLog.error("search_messages_safe failed", {
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
      title: "Summarize Window",
      description: "Summarize a small window around an anchor message (by rowid) for low-token analysis.",
      inputSchema: {
        message_rowid: z
          .number()
          .int()
          .describe("Anchor message_rowid to summarize around."),
        before: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(50)
          .describe("Number of messages before the anchor to consider."),
        after: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(50)
          .describe("Number of messages after the anchor to consider."),
        max_chars: z
          .number()
          .int()
          .min(200)
          .max(20000)
          .default(2000)
          .describe("Character budget for the returned summary lines."),
      },
      outputSchema: {
        summary: z.string(),
        lines: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ message_rowid, before, after, max_chars }) => {
      const rows = await contextAroundMessage(message_rowid, before, after, false);
      const normalized = normalizeMessages(rows as Array<EnrichedMessageRow & { chat_id?: number }>).sort(
        (a, b) => (a.unix_ms ?? 0) - (b.unix_ms ?? 0),
      );
      const ordered = normalized.map((msg) => ({
        t: msg.unix_ms ?? 0,
        from: msg.from_me ? "me" : msg.sender || "other",
        text: msg.text || "",
      }));
      const start = ordered[0]?.t;
      const end = ordered[ordered.length - 1]?.t;
      const participants = Array.from(new Set(ordered.map((r) => r.from)));
      const counts = ordered.reduce((acc: Record<string, number>, r) => {
        acc[r.from] = (acc[r.from] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      const summary = `Window: ${start ? new Date(start).toISOString() : ""} → ${
        end ? new Date(end).toISOString() : ""
      } | Participants: ${participants.join(", ")} | Counts: ${Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}`;
      const lines: string[] = [];
      for (const r of ordered) {
        const stamp = new Date(r.t).toLocaleString("en-US", { hour12: false });
        const line = `${stamp} ${r.from}: ${r.text}`;
        lines.push(line);
      }
      const out: string[] = [];
      let used = 0;
      for (const l of lines) {
        if (used + l.length + 1 > max_chars) break;
        out.push(l);
        used += l.length + 1;
      }
      return {
        content: textContent(summary + "\n" + out.join("\n")),
        structuredContent: { summary, lines: out },
      };
    }
  );

  server.registerResource(
    "inbox",
    INBOX_RESOURCE_URI,
    {
      title: "Inbox Snapshot",
      description: "Latest conversations across Messages with their most recent activity.",
      mimeType: "application/json",
    },
    async () => {
      const snapshot = await buildInboxSnapshot(INBOX_RESOURCE_LIMIT);
      mcpLog.debug("inbox resource generated", {
        conversation_count: snapshot.total_conversations,
        total_unread: snapshot.total_unread,
      });
      return {
        contents: [
          {
            uri: INBOX_RESOURCE_URI,
            mimeType: "application/json",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );

  const conversationTemplate = new ResourceTemplate(CONVERSATION_RESOURCE_TEMPLATE_URI, {
    list: async () => {
      const chats = await listChats(CONVERSATION_RESOURCE_LIST_LIMIT);
      const resources = chats.map((chat) => {
        const participants = extractParticipantsList(chat.participants);
        const label =
          chat.display_name?.trim?.() ||
          (participants.length ? participants.join(", ") : chat.guid) ||
          `chat-${chat.chat_id}`;
        const lastUnix = appleEpochToUnixMs(chat.last_message_date);
        return {
          uri: `messages://conversation/chat-id/${encodeURIComponent(String(chat.chat_id))}`,
          name: label,
          description:
            participants.length > 0
              ? `Participants: ${participants.join(", ")}`
              : `Chat ${chat.chat_id}`,
          mimeType: "application/json",
          last_message_iso: toIsoUtc(lastUnix),
        };
      });
      return { resources };
    },
  });

  server.registerResource(
    "conversation",
    conversationTemplate,
    {
      title: "Conversation Transcript",
      description: "Detailed transcript for an individual Messages chat.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const selector = (variables?.selector ?? variables?.Selector ?? "").toString();
      const value = (variables?.value ?? variables?.Value ?? "").toString();
      if (!selector || !value) {
        throw new Error("Conversation resources require both selector and value path segments.");
      }
      const payload = await buildConversationResourcePayload(selector, value);
      mcpLog.debug("conversation resource generated", {
        selector: payload.selector,
        value: payload.value,
        chat_id: payload.chat.chat_id,
        message_count: payload.messages.length,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
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

type OAuthSetupResult = {
  guard: RequestHandler;
  protectHealth: boolean;
};

function configureOAuth(app: express.Express): OAuthSetupResult | null {
  let config: OAuthRuntimeConfig | null = null;
  try {
    config = loadOAuthRuntimeConfig();
  } catch (error) {
    logger.error("Failed to initialize OAuth configuration", error);
    throw error;
  }

  if (!config) {
    return null;
  }

  const { authOptions, trustProxy, protectHealth, sessionInfoPath } = config;

  logger.info("OAuth protection enabled for HTTP server", {
    issuer: authOptions.issuerBaseURL,
    baseURL: authOptions.baseURL,
    authRequired: authOptions.authRequired ?? false,
    protectHealth,
  });

  if (trustProxy > 0) {
    app.set("trust proxy", trustProxy);
  }

  app.use(auth(authOptions));

  const rawGuard = requiresAuth();
  const guard: RequestHandler = (req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    rawGuard(req, res, next);
  };

  if (sessionInfoPath) {
    app.get(sessionInfoPath, guard, (req: Request, res: Response) => {
      const authenticated = req.oidc?.isAuthenticated?.() ?? false;
      res.json({
        authenticated,
        user: req.oidc?.user ?? null,
        idTokenClaims: req.oidc?.idTokenClaims ?? null,
      });
    });
  }

  return { guard, protectHealth };
}

function parseLaunchOptions(config?: MessagesConfig): LaunchOptions {
  const args = process.argv.slice(2);
  const envHttpFlagDefined = process.env.MESSAGES_MCP_HTTP != null;
  const envHttpPortDefined = process.env.MESSAGES_MCP_HTTP_PORT != null;
  const envHostDefined = process.env.MESSAGES_MCP_HTTP_HOST != null;
  const envSseDefined = process.env.MESSAGES_MCP_HTTP_ENABLE_SSE != null;
  const envDnsDefined = process.env.MESSAGES_MCP_HTTP_DNS_PROTECTION != null;
  const envAllowedHostsDefined = process.env.MESSAGES_MCP_HTTP_ALLOWED_HOSTS != null;
  const envCorsDefined = process.env.MESSAGES_MCP_HTTP_CORS_ORIGINS != null;

  let mode: "stdio" | "http" = parseEnvBool("MESSAGES_MCP_HTTP", false) || envHttpPortDefined ? "http" : "stdio";
  let port = parsePort(process.env.MESSAGES_MCP_HTTP_PORT, 3000);
  let host = (process.env.MESSAGES_MCP_HTTP_HOST || "0.0.0.0").trim() || "0.0.0.0";
  let enableSseFallback = parseEnvBool("MESSAGES_MCP_HTTP_ENABLE_SSE", false);
  let dnsRebindingProtection = parseEnvBool("MESSAGES_MCP_HTTP_DNS_PROTECTION", true);
  let allowedHosts = parseCsv(process.env.MESSAGES_MCP_HTTP_ALLOWED_HOSTS);
  let corsOrigins = parseCsv(process.env.MESSAGES_MCP_HTTP_CORS_ORIGINS);

  let modeExplicit = envHttpFlagDefined || envHttpPortDefined;
  let portExplicit = envHttpPortDefined;
  let hostExplicit = envHostDefined;
  let sseExplicit = envSseDefined;
  let dnsExplicit = envDnsDefined;
  let allowedHostsExplicit = envAllowedHostsDefined;
  let corsExplicit = envCorsDefined;

  const takeValue = (index: number): string | undefined => {
    const value = args[index + 1];
    return typeof value === "string" ? value : undefined;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      mode = "http";
      modeExplicit = true;
      continue;
    }
    if (arg === "--stdio") {
      mode = "stdio";
      modeExplicit = true;
      continue;
    }
    if (arg === "--port") {
      const value = takeValue(i);
      if (value) {
        port = parsePort(value, port);
        i++;
        mode = "http";
        portExplicit = true;
        modeExplicit = true;
      }
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.split("=", 2)[1], port);
      mode = "http";
      portExplicit = true;
      modeExplicit = true;
      continue;
    }
    if (arg === "--host") {
      const value = takeValue(i);
      if (value) {
        host = value;
        i++;
        mode = "http";
        hostExplicit = true;
        modeExplicit = true;
      }
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.split("=", 2)[1];
      mode = "http";
      hostExplicit = true;
      modeExplicit = true;
      continue;
    }
    if (arg === "--enable-sse" || arg === "--sse") {
      enableSseFallback = true;
      sseExplicit = true;
      continue;
    }
    if (arg === "--disable-sse") {
      enableSseFallback = false;
      sseExplicit = true;
      continue;
    }
    if (arg === "--cors-origin") {
      const value = takeValue(i);
      if (value) {
        corsOrigins = value === "*" ? ["*"] : [...new Set([...corsOrigins.filter((o) => o !== "*"), value])];
        i++;
      }
      corsExplicit = true;
      continue;
    }
    if (arg.startsWith("--cors-origin=")) {
      const value = arg.split("=", 2)[1];
      corsOrigins = value === "*" ? ["*"] : [...new Set([...corsOrigins.filter((o) => o !== "*"), value])];
      corsExplicit = true;
      continue;
    }
    if (arg === "--enable-dns-protection") {
      dnsRebindingProtection = true;
      dnsExplicit = true;
      continue;
    }
    if (arg === "--disable-dns-protection") {
      dnsRebindingProtection = false;
      dnsExplicit = true;
      continue;
    }
    if (arg === "--allowed-host") {
      const value = takeValue(i);
      if (value) {
        allowedHosts = [...new Set([...allowedHosts, value])];
        i++;
      }
      allowedHostsExplicit = true;
      continue;
    }
    if (arg.startsWith("--allowed-host=")) {
      const value = arg.split("=", 2)[1];
      allowedHosts = [...new Set([...allowedHosts, value])];
      allowedHostsExplicit = true;
      continue;
    }
  }

  if (!modeExplicit && config?.transport === "http") {
    mode = "http";
  }

  if (mode === "http") {
    const httpConfig = config?.http;
    if (httpConfig) {
      if (!portExplicit && typeof httpConfig.port === "number") {
        port = httpConfig.port;
      }
      if (!hostExplicit && typeof httpConfig.host === "string") {
        host = httpConfig.host;
      }
      if (!sseExplicit && typeof httpConfig.enableSseFallback === "boolean") {
        enableSseFallback = httpConfig.enableSseFallback;
      }
      if (!dnsExplicit && typeof httpConfig.dnsRebindingProtection === "boolean") {
        dnsRebindingProtection = httpConfig.dnsRebindingProtection;
      }
      if (!allowedHostsExplicit && Array.isArray(httpConfig.allowedHosts) && httpConfig.allowedHosts.length) {
        allowedHosts = [...new Set(httpConfig.allowedHosts)];
      }
      if (!corsExplicit && Array.isArray(httpConfig.corsOrigins) && httpConfig.corsOrigins.length) {
        corsOrigins = [...new Set(httpConfig.corsOrigins)];
      }
    }
    if (dnsRebindingProtection && !allowedHosts.length) {
      allowedHosts = buildDefaultHostAllowlist(host, port);
    }
    allowedHosts = normalizeAllowedHosts(allowedHosts, port);
    if (!corsOrigins.length) {
      corsOrigins = buildDefaultCorsOrigins(host, port);
    }
    if (!corsExplicit && !corsOrigins.includes("*")) {
      corsOrigins = ["*"];
    }
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
    const originSetting =
      options.corsOrigins.length === 1 && options.corsOrigins[0] === "*" ? "*" : options.corsOrigins;
    app.use(cors({
      origin: originSetting,
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version"],
    }));
  }

  const oauthSetup = configureOAuth(app);
  const authGuard = oauthSetup?.guard ?? null;
  if (authGuard) {
    app.use("/mcp", authGuard);
    if (options.enableSseFallback) {
      app.use("/messages", authGuard);
      app.use("/sse", authGuard);
    }
    if (oauthSetup?.protectHealth) {
      app.use("/health", authGuard);
    }
  }

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const legacySessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  function* enumerateConnectedServers(): IterableIterator<McpServer> {
    for (const entry of sessions.values()) {
      yield entry.server;
    }
    for (const entry of legacySessions.values()) {
      yield entry.server;
    }
  }

  const httpLog = {
    debug: (...args: unknown[]) => broadcastLog("debug", args, enumerateConnectedServers()),
    info: (...args: unknown[]) => broadcastLog("info", args, enumerateConnectedServers()),
    warn: (...args: unknown[]) => broadcastLog("warning", args, enumerateConnectedServers()),
    error: (...args: unknown[]) => broadcastLog("error", args, enumerateConnectedServers()),
  } as const;

  app.get("/mcp/manifest", (_req: Request, res: Response) => {
    const versionInfo = getVersionInfoSync();
    const manifest = {
      manifestVersion: CONNECTOR_MANIFEST_VERSION,
      name: versionInfo.name,
      version: versionInfo.version,
      description: "Expose macOS Messages history, search, and sending flows over MCP.",
      documentationUrl: CONNECTOR_DEFAULT_DOCS_URL,
      contact: {
        email: CONNECTOR_DEFAULT_CONTACT,
      },
      legal: {
        privacyPolicyUrl: CONNECTOR_DEFAULT_PRIVACY_URL,
        termsOfServiceUrl: CONNECTOR_DEFAULT_TOS_URL,
      },
      security: {
        authentication: authGuard ? "oauth" : "none",
      },
      transport: {
        type: "streamable-http" as const,
        endpoints: {
          command: "/mcp",
          sse: options.enableSseFallback ? "/sse" : null,
        },
        allowedHosts: options.allowedHosts,
        dnsRebindingProtection: options.dnsRebindingProtection,
      },
      capabilities: CONNECTOR_MANIFEST_CAPABILITIES,
      tools: CONNECTOR_MANIFEST_TOOLS,
    };
    res.json(manifest);
  });

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
            openLogViewer();
          },
          enableDnsRebindingProtection: options.dnsRebindingProtection,
          allowedHosts: options.allowedHosts.length ? options.allowedHosts : undefined,
          allowedOrigins: options.corsOrigins.includes("*") ? undefined : options.corsOrigins,
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
      httpLog.error("HTTP transport error:", error);
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
      openLogViewer();
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

  // Keep the HTTP launch path alive until the server is explicitly closed.
  return new Promise<void>((resolve, reject) => {
    let server: ReturnType<typeof app.listen> | null = null;
    try {
      server = app.listen(options.port, options.host, () => {
        httpLog.info(`messages-app-mcp HTTP server listening on http://${options.host}:${options.port}`);
        if (options.enableSseFallback) {
          httpLog.info("Legacy SSE fallback enabled at /sse");
        }
      });
    } catch (error) {
      httpLog.error("HTTP server failed to start", error);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let settled = false;

    function cleanup() {
      if (!server) return;
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      server.off("close", onClose);
      server.off("error", onError);
      server = null;
    }

    function settleResolve() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function settleReject(error?: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error ?? new Error("HTTP server failed"));
    }

    function onClose() {
      settleResolve();
    }

    function onError(error: Error) {
      httpLog.error("HTTP server error", error);
      settleReject(error);
    }

    function shutdown() {
      if (settled || !server) return;
      server.close((err) => {
        if (err) {
          onError(err);
        } else {
          onClose();
        }
      });
    }

    server.on("close", onClose);
    server.on("error", onError);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
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
    openLogViewer();
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

export class MessagesRuntime {
  constructor(private readonly config: MessagesConfig) {}

  createServer(): McpServer {
    return createConfiguredServer();
  }

  async startStdio(): Promise<void> {
    await runStdioServer();
  }

  async startHttp(options: HttpLaunchOptions): Promise<void> {
    await runHttpServer(options);
  }
}

async function main() {
  const config = await loadMessagesConfig();
  applyConfigToLogViewer(config);
  const runtime = new MessagesRuntime(config);
  const launch = parseLaunchOptions(config);
  logger.info("messages-app-mcp starting", { mode: launch.mode });
  await ensureLogViewer();
  if (launch.mode === "stdio") {
    await runtime.startStdio();
    return;
  }

  await runtime.startHttp(launch);
}

main().catch((err) => {
  logger.error("messages-app-mcp failed:", err);
  process.exit(1);
});
