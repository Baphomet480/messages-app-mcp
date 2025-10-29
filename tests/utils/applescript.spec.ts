import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn<(typeof import("node:child_process"))['execFile']>();
const defaultExecImplementation: (typeof import("node:child_process"))['execFile'] = ((cmd: any, args: any, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
  }
  callback?.(null, Buffer.from("imessage"), Buffer.from(""));
  return {} as any;
}) as any;

const statMock = vi.fn(async () => ({
  isFile: () => true,
}));

const mkdtempMock = vi.fn(async () => "/tmp/messages-mcp-abc");
const writeFileMock = vi.fn(async () => {});
const rmMock = vi.fn(async () => {});

vi.mock("node:child_process", () => ({
  execFile: (...args: Parameters<typeof defaultExecImplementation>) => execFileMock(...args),
}));

vi.mock("node:fs/promises", () => ({
  stat: (...args: Parameters<typeof statMock>) => statMock(...args),
  mkdtemp: (...args: Parameters<typeof mkdtempMock>) => mkdtempMock(...args),
  writeFile: (...args: Parameters<typeof writeFileMock>) => writeFileMock(...args),
  rm: (...args: Parameters<typeof rmMock>) => rmMock(...args),
}));

vi.mock("node:os", () => ({
  homedir: () => "/Users/tester",
  tmpdir: () => "/tmp",
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return actual;
});

import {
  sendMessageAppleScript,
  sendAttachmentAppleScript,
  MESSAGES_FDA_HINT,
} from "../../src/utils/applescript.js";

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(defaultExecImplementation as any);
  statMock.mockReset();
  statMock.mockResolvedValue({
    isFile: () => true,
  });
  mkdtempMock.mockReset();
  mkdtempMock.mockResolvedValue("/tmp/messages-mcp-xyz");
  writeFileMock.mockReset();
  rmMock.mockReset();
});

describe("sendMessageAppleScript", () => {
  it("throws if message text is empty", async () => {
    await expect(sendMessageAppleScript("+15550001111", "  ")).rejects.toThrow(
      "Message text must not be empty.",
    );
  });

  it("invokes fallback script for recipient targets and returns route", async () => {
    mkdtempMock.mockResolvedValueOnce("/tmp/messages-mcp-123");
    const result = await sendMessageAppleScript("  +15550000000  ", " Hello there ");

    expect(result.route).toBe("imessage");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe("/usr/bin/osascript");
    const argv = Array.isArray(args) ? args : [];
    expect(argv[0]).toMatch(/scripts\/applescript\/send_message\.applescript$/);
    expect(argv[1]).toBe("+15550000000");
    expect(argv[2]).toBe("/tmp/messages-mcp-123/body.txt");

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/messages-mcp-123/body.txt",
      " Hello there ",
      { encoding: "utf8" },
    );

    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith("/tmp/messages-mcp-123", { recursive: true, force: true });
  });

  it("prefers chat identifiers when provided", async () => {
    mkdtempMock.mockResolvedValueOnce("/tmp/messages-mcp-456");
    await sendMessageAppleScript(
      { chatGuid: "chat123", chatName: "Ignore" },
      "ping",
    );

    const callArgs = execFileMock.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args.slice(-4)).toEqual(["text_path", "chat", "chat123", "/tmp/messages-mcp-456/body.txt"]);
  });

  it("surfaces sms route when fallback script returns sms", async () => {
    mkdtempMock.mockResolvedValueOnce("/tmp/messages-mcp-789");
    execFileMock.mockImplementationOnce((cmd: any, args: any, options: any, callback: any) => {
      if (typeof options === "function") {
        callback = options;
      }
      callback?.(null, Buffer.from("sms"), Buffer.from(""));
      return {} as any;
    });
    const result = await sendMessageAppleScript("+15551231212", "fallback check");
    expect(result.route).toBe("sms");
  });
});

describe("sendAttachmentAppleScript", () => {
  it("normalizes tilded paths and sends attachment", async () => {
    await sendAttachmentAppleScript("friend", "~/Desktop/notes.txt", " optional caption ");

    expect(statMock).toHaveBeenCalledWith("/Users/tester/Desktop/notes.txt");
    const callArgs = execFileMock.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args.slice(-5)).toEqual([
      "file",
      "recipient",
      "friend",
      "/Users/tester/Desktop/notes.txt",
      " optional caption ",
    ]);
  });

  it("rejects when the path does not point to a file", async () => {
    statMock.mockResolvedValueOnce({
      isFile: () => false,
    });

    await expect(sendAttachmentAppleScript("friend", "/tmp", undefined)).rejects.toThrow(
      /is not a file/,
    );
  });

  it("rejects with helpful message when file is missing", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    statMock.mockRejectedValueOnce(enoent);

    await expect(sendAttachmentAppleScript("friend", "/missing.txt", undefined)).rejects.toThrow(
      /Attachment not found/,
    );
  });

  it("maps osascript POSIX errors to Full Disk Access hint", async () => {
    execFileMock.mockImplementationOnce((cmd: any, args: any, opts: any, cb: any) => {
      cb(new Error("POSIX file error"), Buffer.from(""), Buffer.from("POSIX file error"));
      return {} as any;
    });

    await expect(
      sendAttachmentAppleScript("friend", "/Users/tester/file.txt", undefined),
    ).rejects.toThrow(MESSAGES_FDA_HINT);
  });
});
