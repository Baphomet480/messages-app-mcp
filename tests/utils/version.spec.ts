import { describe, it, expect, vi } from "vitest";
import pkg from "../../package.json";

const execMock = vi.fn();

async function loadModule() {
  vi.resetModules();
  execMock.mockReset();
  vi.doMock("node:child_process", () => ({ execFile: execMock }));
  return import("../../src/utils/version.js");
}

describe("getVersionInfo", () => {
  it("includes git commit when available", async () => {
    const { getVersionInfo } = await loadModule();
    execMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(null, "abcdef1234567890\n", "");
      return {} as any;
    });
    const info = await getVersionInfo();
    expect(info.name).toBe(pkg.name);
    expect(info.version).toBe(pkg.version);
    expect(info.git_commit).toBe("abcdef1234567890");
    expect(info.git_commit_short).toBe("abcdef1");
  });

  it("gracefully handles git errors", async () => {
    const { getVersionInfo } = await loadModule();
    execMock.mockImplementation((file, args, options, callback) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      cb(new Error("git not found"), "", "git not found");
      return {} as any;
    });
    const info = await getVersionInfo();
    expect(info.git_commit).toBeNull();
    expect(info.git_commit_short).toBeNull();
  });
});
