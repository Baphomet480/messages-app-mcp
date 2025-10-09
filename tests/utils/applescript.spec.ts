import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn<(typeof import("node:child_process"))['execFile']>();
const defaultExecImplementation: (typeof import("node:child_process"))['execFile'] = ((cmd: any, args: any, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
  }
  callback?.(null, Buffer.from("ok"), Buffer.from(""));
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

  it("invokes osascript with recipient mode for string targets", async () => {
    mkdtempMock.mockResolvedValueOnce("/tmp/messages-mcp-123");
    await sendMessageAppleScript("  +15550000000  ", " Hello there ");

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const callArgs = execFileMock.mock.calls[0]!;
    const args = callArgs[1] as string[];
    expect(args[0]).toBe("-l");
    expect(args[1]).toBe("AppleScript");
    expect(args[3]).toContain("on run argv");
    expect(args.slice(-4)).toEqual(["text_path", "recipient", "+15550000000", "/tmp/messages-mcp-123/body.txt"]);
    expect(writeFileMock).toHaveBeenCalledWith("/tmp/messages-mcp-123/body.txt", " Hello there ", { encoding: "utf8" });
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
