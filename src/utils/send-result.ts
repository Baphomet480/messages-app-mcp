export type SendTargetDescriptor = {
  recipient: string | null;
  chat_guid: string | null;
  chat_name: string | null;
  display: string;
};

export type MessageLike = {
  from_me: boolean;
  unix_ms: number | null;
  [key: string]: unknown;
};

export type SendSuccessPayload<TMessage extends MessageLike> = {
  status: "sent";
  summary: string;
  target: SendTargetDescriptor;
  chat_id?: number | null;
  latest_message?: TMessage | null;
  recent_messages?: TMessage[];
  lookup_error?: string;
};

export type SendFailurePayload = {
  status: "failed";
  summary: string;
  target: SendTargetDescriptor;
  error: string;
};

export type SendResultPayload<TMessage extends MessageLike> =
  | SendSuccessPayload<TMessage>
  | SendFailurePayload;

export function selectRecentMessages<TMessage extends MessageLike>(
  messages: TMessage[],
  limit = 5,
): { latest: TMessage | null; recent: TMessage[] } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { latest: null, recent: [] };
  }
  const sorted = [...messages].sort((a, b) => {
    const aTime = typeof a.unix_ms === "number" && Number.isFinite(a.unix_ms) ? a.unix_ms : 0;
    const bTime = typeof b.unix_ms === "number" && Number.isFinite(b.unix_ms) ? b.unix_ms : 0;
    return bTime - aTime;
  });
  const latest = sorted.find((msg) => msg.from_me) ?? sorted[0] ?? null;
  const max = Math.max(0, limit);
  const recent = max > 0 ? sorted.slice(0, max) : [];
  return { latest, recent };
}

export function buildSendSuccessPayload<TMessage extends MessageLike>(options: {
  target: SendTargetDescriptor;
  chatId?: number | null;
  messages?: TMessage[];
  lookupError?: string | null;
  summary?: string;
}): SendSuccessPayload<TMessage> {
  const { target, chatId = null, messages = [], lookupError, summary } = options;
  const { latest, recent } = selectRecentMessages(messages);
  const payload: SendSuccessPayload<TMessage> = {
    status: "sent",
    summary: summary ?? `Sent message to ${target.display}.`,
    target,
  };
  if (chatId != null) payload.chat_id = chatId;
  if (latest) payload.latest_message = latest;
  if (recent.length) payload.recent_messages = recent;
  if (lookupError) payload.lookup_error = lookupError;
  return payload;
}

export function buildSendFailurePayload(
  target: SendTargetDescriptor,
  reason: string,
  options: { summary?: string } = {},
): SendFailurePayload {
  const trimmed = reason?.trim?.() ?? reason;
  const summary = options.summary ?? `Failed to send to ${target.display}. ${trimmed}`.trim();
  return {
    status: "failed",
    summary,
    target,
    error: trimmed,
  };
}
