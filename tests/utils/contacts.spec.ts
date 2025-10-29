import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runAppleScriptAssetMock = vi.fn();
const loggerMockFactory = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

type ContactsMode = "default" | "enabled" | "disabled";

async function loadContactsModule(mode: ContactsMode) {
  vi.resetModules();
  if (mode === "enabled") {
    process.env.MESSAGES_MCP_CONTACTS = "1";
  } else if (mode === "disabled") {
    process.env.MESSAGES_MCP_CONTACTS = "0";
  } else {
    delete process.env.MESSAGES_MCP_CONTACTS;
  }
  vi.doMock("../../src/utils/logger.js", () => ({
    getLogger: () => loggerMockFactory(),
  }));
  vi.doMock("../../src/utils/applescript.js", () => ({
    runAppleScriptAsset: runAppleScriptAssetMock,
  }));
  return import("../../src/utils/contacts.js");
}

beforeEach(() => {
  runAppleScriptAssetMock.mockReset();
  delete process.env.MESSAGES_MCP_CONTACTS;
});

afterEach(() => {
  delete process.env.MESSAGES_MCP_CONTACTS;
  vi.resetModules();
});

describe("contacts feature flag", () => {
  it("enables lookups by default", async () => {
    const mod = await loadContactsModule("default");
    expect(mod.contactsFeatureEnabled()).toBe(true);
    runAppleScriptAssetMock.mockResolvedValueOnce("Default Enabled");
    const result = await mod.resolveContactName("+15551234567");
    expect(result).toBe("Default Enabled");
    expect(runAppleScriptAssetMock).toHaveBeenCalledWith(
      "contacts.applescript",
      ["lookup", "+15551234567"],
    );
  });

  it("allows disabling via env variable", async () => {
    const mod = await loadContactsModule("disabled");
    expect(mod.contactsFeatureEnabled()).toBe(false);
    const name = await mod.resolveContactName("+15550112233");
    expect(name).toBeNull();
    expect(runAppleScriptAssetMock).not.toHaveBeenCalled();
  });

  it("still respects explicit enable flag", async () => {
    runAppleScriptAssetMock.mockResolvedValueOnce("Alice Nguyen");
    const mod = await loadContactsModule("enabled");
    expect(mod.contactsFeatureEnabled()).toBe(true);
    const name = await mod.resolveContactName("+15551234567");
    expect(name).toBe("Alice Nguyen");
    expect(runAppleScriptAssetMock).toHaveBeenCalledWith(
      "contacts.applescript",
      ["lookup", "+15551234567"],
    );
  });
});

describe("resolveContactName caching", () => {
  it("caches successful lookups", async () => {
    runAppleScriptAssetMock.mockResolvedValueOnce("Taylor Swift");
    const mod = await loadContactsModule("enabled");
    const first = await mod.resolveContactName(" +15550000000 ");
    const second = await mod.resolveContactName("+15550000000");
    expect(first).toBe("Taylor Swift");
    expect(second).toBe("Taylor Swift");
    expect(runAppleScriptAssetMock).toHaveBeenCalledTimes(1);
  });

  it("records null on failure and does not retry immediately", async () => {
    runAppleScriptAssetMock.mockRejectedValueOnce(new Error("Contacts.app not available"));
    const mod = await loadContactsModule("enabled");
    const value = await mod.resolveContactName("+18885550000");
    expect(value).toBeNull();
    expect(runAppleScriptAssetMock).toHaveBeenCalledTimes(1);
    // Subsequent lookup should use cached null and avoid another AppleScript spawn.
    const second = await mod.resolveContactName("+18885550000");
    expect(second).toBeNull();
    expect(runAppleScriptAssetMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveContactNames batch helper", () => {
  it("deduplicates canonical handles and returns trimmed keys", async () => {
    runAppleScriptAssetMock
      .mockResolvedValueOnce("Charlie Contact")
      .mockResolvedValueOnce("Delta Contact");
    const mod = await loadContactsModule("enabled");
    const result = await mod.resolveContactNames([" +1999 ", "+1999", " +1222 "]);
    expect(runAppleScriptAssetMock).toHaveBeenCalledTimes(2);
    expect(result.get("+1999")).toBe("Charlie Contact");
    expect(result.get("+1222")).toBe("Delta Contact");
  });
});

describe("searchContacts", () => {
  it("returns empty array when disabled", async () => {
    const mod = await loadContactsModule("disabled");
    const results = await mod.searchContacts("anyone", 5);
    expect(results).toEqual([]);
    expect(runAppleScriptAssetMock).not.toHaveBeenCalled();
  });

  it("parses JSON payload from AppleScript", async () => {
    runAppleScriptAssetMock.mockResolvedValueOnce(
      JSON.stringify([
        { name: "Eve Example", phones: ["+123"], emails: ["eve@example.com"] },
        { name: "Frank Friend", phones: [], emails: [] },
      ]),
    );
    const mod = await loadContactsModule("enabled");
    const results = await mod.searchContacts("e", 10);
    expect(results).toEqual([
      { name: "Eve Example", phones: ["+123"], emails: ["eve@example.com"] },
      { name: "Frank Friend", phones: [], emails: [] },
    ]);
    expect(runAppleScriptAssetMock).toHaveBeenCalledWith("contacts.applescript", ["search", "e", "10"]);
  });
});
