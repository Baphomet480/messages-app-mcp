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
