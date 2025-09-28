import { describe, it, expect } from "vitest";
import {
  buildSendFailurePayload,
  buildSendSuccessPayload,
  selectRecentMessages,
  type MessageLike,
} from "../../src/utils/send-result.js";

describe("selectRecentMessages", () => {
  const baseMessages: MessageLike[] = [
    { from_me: false, unix_ms: 1_000, text: "old incoming" },
    { from_me: true, unix_ms: 2_000, text: "latest from me" },
    { from_me: false, unix_ms: 3_000, text: "new incoming" },
  ];

  it("prioritizes the most recent outgoing message", () => {
    const { latest, recent } = selectRecentMessages(baseMessages, 2);
    expect(latest?.text).toBe("latest from me");
    expect(recent.map((m) => m.text)).toEqual(["new incoming", "latest from me"]);
  });

  it("falls back to most recent message when no outgoing exists", () => {
    const messages: MessageLike[] = [
      { from_me: false, unix_ms: 5_000, text: "new incoming" },
      { from_me: false, unix_ms: 1_000, text: "old incoming" },
    ];
    const { latest, recent } = selectRecentMessages(messages, 1);
    expect(latest?.text).toBe("new incoming");
    expect(recent.map((m) => m.text)).toEqual(["new incoming"]);
  });

  it("returns empty when no messages provided", () => {
    const { latest, recent } = selectRecentMessages([], 3);
    expect(latest).toBeNull();
    expect(recent).toEqual([]);
  });
});

describe("buildSendSuccessPayload", () => {
  const target = {
    recipient: "+15551231234",
    chat_guid: null,
    chat_name: null,
    display: "+15551231234",
  };

  it("includes latest message, recent slice, and chat id", () => {
    const messages: MessageLike[] = [
      { from_me: true, unix_ms: 1_000, text: "hello" },
      { from_me: false, unix_ms: 1_500, text: "hi" },
    ];
    const payload = buildSendSuccessPayload({ target, chatId: 42, messages });
    expect(payload.status).toBe("sent");
    expect(payload.summary).toContain("+15551231234");
    expect(payload.chat_id).toBe(42);
    expect(payload.latest_message?.text).toBe("hello");
    expect(payload.recent_messages?.map((m) => m.text)).toEqual(["hi", "hello"]);
  });

  it("omits optional fields when data missing", () => {
    const payload = buildSendSuccessPayload({ target, messages: [] });
    expect(payload.chat_id).toBeUndefined();
    expect(payload.latest_message).toBeUndefined();
    expect(payload.recent_messages).toBeUndefined();
  });

  it("includes lookup error when provided", () => {
    const payload = buildSendSuccessPayload({ target, lookupError: "missing chat" });
    expect(payload.lookup_error).toBe("missing chat");
  });

  it("allows custom summary", () => {
    const payload = buildSendSuccessPayload({ target, summary: "Custom summary" });
    expect(payload.summary).toBe("Custom summary");
  });
});

describe("buildSendFailurePayload", () => {
  const target = {
    recipient: null,
    chat_guid: "chat123",
    chat_name: "Family",
    display: "chat \"Family\"",
  };

  it("returns structured failure payload", () => {
    const payload = buildSendFailurePayload(target, "No service");
    expect(payload.status).toBe("failed");
    expect(payload.summary).toContain("No service");
    expect(payload.error).toBe("No service");
    expect(payload.target).toBe(target);
  });

  it("accepts summary override", () => {
    const payload = buildSendFailurePayload(target, "No service", { summary: "Custom fail" });
    expect(payload.summary).toBe("Custom fail");
    expect(payload.error).toBe("No service");
  });
});
