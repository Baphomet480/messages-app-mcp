import { describe, it, expect } from "vitest";
import { runDoctor } from "../../src/utils/doctor.js";

// Integration-style check that the doctor tool returns version metadata and expected fields.
describe("doctor integration", () => {
  it("includes version metadata in structured response", async () => {
    const report = await runDoctor();
    expect(report.package_name).toBe("messages-app-mcp");
    expect(typeof report.package_version).toBe("string");
    expect(report.package_version.length).toBeGreaterThan(0);
    // git commit fields may be null when git is unavailable, but keys should exist
    expect(report).toHaveProperty("git_commit");
    expect(report).toHaveProperty("git_commit_short");
    expect(report.summary).toContain("messages-app-mcp v");
  });
});
