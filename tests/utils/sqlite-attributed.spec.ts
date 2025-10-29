import { describe, it, expect, vi } from "vitest";

const execFileMock = vi.fn();

async function loadSqliteModule() {
  vi.resetModules();
  execFileMock.mockReset();
  vi.doMock("node:child_process", () => ({
    execFile: execFileMock,
  }));
  vi.doMock("imessage-parser", () => ({
    parseAttributedBody: () => ({
      text: "Rendered attributed body 😊",
      attributes: {
        attachments: [],
        mentions: [],
        links: [],
        dataDetectors: [],
      },
      link: null,
    }),
  }));
  return import("../../src/utils/sqlite.js");
}

describe("hydrateAttributedBodies", () => {
  it("hydrates decoded_text when plain text is missing", async () => {
    const { searchMessages } = await loadSqliteModule();
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
          { name: "attributedBody" },
        ]), "");
        return {} as any;
      }
      if (sql.includes("FROM chat_message_join")) {
        const results = [
          {
            message_rowid: 22,
            guid: "GUID-ATTR",
            is_from_me: 0,
            text: null,
            has_attachments: 0,
            date: 5_000_000_000,
            sender: "+15550001111",
            chat_id: 7,
            body_hex: Buffer.from("Mocked binary body").toString("hex"),
          },
        ];
        cb(null, JSON.stringify(results), "");
        return {} as any;
      }
      cb(null, "[]", "");
      return {} as any;
    });

    const [row] = await searchMessages({
      query: "Mocked",
      chatId: 7,
      includeAttachmentsMeta: false,
    });

    expect(row.decoded_text).toBe("Rendered attributed body 😊");
    expect(row.attributed_body_meta?.text).toBe("Rendered attributed body 😊");
  });
});
