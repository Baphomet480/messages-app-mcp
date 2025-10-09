import { describe, it, expect } from "vitest";
import { normalizeMessageText, truncateForLog, extractLongestPrintable } from "../../src/utils/text-utils.js";

describe("text-utils", () => {
  it("normalizes whitespace and strips replacement glyphs", () => {
    const raw = "\uFFFC Quick\nmessage\uFFFD";
    expect(normalizeMessageText(raw)).toBe("Quick message");
  });

  it("returns null when only replacement glyphs remain", () => {
    expect(normalizeMessageText("\uFFFC\uFFFD")).toBeNull();
  });

  it("truncates long strings with ellipsis", () => {
    const value = "This is a very long message that should be truncated";
    expect(truncateForLog(value, 20)).toBe("This is a very long…");
  });

  it("extracts printable sequences from binary blobs", () => {
    const buffer = Buffer.concat([
      Buffer.from([0x00, 0x2B, 0x3D]),
      Buffer.from("Hello World!", "utf8"),
      Buffer.from([0x00]),
    ]);
    expect(extractLongestPrintable(buffer)).toBe("Hello World!");
  });
});
