import { describe, it, expect } from "vitest";
import {
  normalizeMessageText,
  truncateForLog,
  extractLongestPrintable,
  estimateSegmentInfo,
} from "../../src/utils/text-utils.js";

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

  it("estimates segments for GSM-7 text", () => {
    const info = estimateSegmentInfo("Hello world");
    expect(info.encoding).toBe("gsm-7");
    expect(info.segments).toBe(1);
    expect(info.unitCount).toBe(11);
    expect(info.segmentSize).toBe(160);
  });

  it("uses concatenated gsm segment size when threshold exceeded", () => {
    const info = estimateSegmentInfo("a".repeat(161));
    expect(info.encoding).toBe("gsm-7");
    expect(info.segments).toBe(2);
    expect(info.segmentSize).toBe(153);
  });

  it("falls back to UCS-2 for emoji and counts code points", () => {
    const info = estimateSegmentInfo("hello 😊");
    expect(info.encoding).toBe("ucs-2");
    expect(info.segments).toBe(1);
    expect(info.segmentSize).toBe(70);
    expect(info.unitCount).toBe(7);
  });
});
