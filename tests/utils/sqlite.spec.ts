import { describe, it, expect, vi } from "vitest";

const execFileMock = vi.fn();

async function loadSqliteModule() {
  vi.resetModules();
  execFileMock.mockReset();
  vi.doMock("node:child_process", () => ({
    execFile: execFileMock,
  }));
  return import("../../src/utils/sqlite.js");
}

describe("getChatIdByDisplayName", () => {
  it("returns chat id when display name matches", async () => {
    const { getChatIdByDisplayName } = await loadSqliteModule();
    execFileMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const argv = Array.isArray(args) ? args : [];
      const sql = typeof argv[3] === "string" ? argv[3] : "";
      if (sql.includes("FROM chat")) {
        cb(null, '[{"chat_id":99}]', "");
      } else {
        cb(null, "[]", "");
      }
      return {} as any;
    });

    const result = await getChatIdByDisplayName("Family");
    expect(result).toBe(99);
  });

  it("returns null when no rows", async () => {
    const { getChatIdByDisplayName } = await loadSqliteModule();
    execFileMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(null, "[]", "");
      return {} as any;
    });

    const result = await getChatIdByDisplayName("Missing");
    expect(result).toBeNull();
  });
});

describe("getChatIdByParticipant", () => {
  it("resolves chat id using latest activity", async () => {
    const { getChatIdByParticipant } = await loadSqliteModule();
    execFileMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const argv = Array.isArray(args) ? args : [];
      const sql = typeof argv[3] === "string" ? argv[3] : "";
      if (sql.includes("PRAGMA table_info(handle)")) {
        cb(null, '[{"name":"ROWID"},{"name":"id"}]', "");
      } else if (sql.includes("WITH target_chats")) {
        cb(null, '[{"chat_id":60}]', "");
      } else {
        cb(null, "[]", "");
      }
      return {} as any;
    });

    const result = await getChatIdByParticipant("+15551234567");
    expect(result).toBe(60);
  });

  it("returns null when no chats match", async () => {
    const { getChatIdByParticipant } = await loadSqliteModule();
    execFileMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const argv = Array.isArray(args) ? args : [];
      const sql = typeof argv[3] === "string" ? argv[3] : "";
      if (sql.includes("PRAGMA table_info(handle)")) {
        cb(null, '[{"name":"ROWID"},{"name":"id"}]', "");
      } else if (sql.includes("WITH target_chats")) {
        cb(null, "[]", "");
      } else {
        cb(null, "[]", "");
      }
      return {} as any;
    });

    const result = await getChatIdByParticipant("+15550000000");
    expect(result).toBeNull();
  });
});

describe("searchMessages", () => {
  it("rejects missing scope filters", async () => {
    const { searchMessages } = await loadSqliteModule();
    await expect(searchMessages({ query: "hello" })).rejects.toThrow(/requires at least one scope filter/i);
  });

  it("returns mixed service rows with attachment hints", async () => {
    const { searchMessages } = await loadSqliteModule();
    const appleEpochBase = 978307200 * 1000;
    execFileMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const argv = Array.isArray(args) ? args : [];
      const sql = typeof argv[3] === "string" ? argv[3] : "";
      if (sql.includes("PRAGMA table_info(message)")) {
        cb(null, JSON.stringify([
          { name: "ROWID" },
          { name: "guid" },
          { name: "is_from_me" },
          { name: "text" },
          { name: "cache_has_attachments" },
          { name: "date" },
          { name: "service" },
          { name: "account" },
        ]), "");
        return {} as any;
      }
      if (sql.includes("FROM chat_message_join")) {
        const results = [
          {
            message_rowid: 10,
            guid: "GUID-IM",
            is_from_me: 1,
            text: "hey there",
            has_attachments: 0,
            date: appleEpochBase + 120000,
            sender: null,
            chat_id: 42,
            service: "iMessage",
            atts_concat: null,
          },
          {
            message_rowid: 11,
            guid: "GUID-SMS",
            is_from_me: 0,
            text: "reply via sms",
            has_attachments: 1,
            date: appleEpochBase + 180000,
            sender: "+15551234567",
            chat_id: 42,
            service: "SMS",
            atts_concat: "photo.jpg|image/jpeg|~/Library/Messages/Attachments/12/photo.jpg",
          },
        ];
        cb(null, JSON.stringify(results), "");
        return {} as any;
      }
      cb(null, "[]", "");
      return {} as any;
    });

    const rows = await searchMessages({
      query: "hey",
      chatId: 42,
      limit: 20,
      includeAttachmentsMeta: true,
    });

    expect(rows).toHaveLength(2);
    const sms = rows.find((row) => row.service === "SMS");
    expect(sms).toBeTruthy();
    expect(sms?.attachments_meta).toEqual([
      { name: "photo.jpg", mime: "image/jpeg", filename: "photo.jpg" },
    ]);
  });
});
