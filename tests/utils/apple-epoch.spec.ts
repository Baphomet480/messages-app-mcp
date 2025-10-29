import { describe, it, expect } from "vitest";
import { appleEpochToUnixMs } from "../../src/utils/sqlite.js";

const APPLE_EPOCH_SEC = 978307200;

function toAppleUnits(unixMs: number, scale: number): number {
  const secondsSinceApple = unixMs / 1000 - APPLE_EPOCH_SEC;
  return Math.round(secondsSinceApple * scale);
}

describe("appleEpochToUnixMs", () => {
  it("converts apple seconds to unix milliseconds", () => {
    const appleSeconds = 360;
    const expected = (APPLE_EPOCH_SEC + appleSeconds) * 1000;
    expect(appleEpochToUnixMs(appleSeconds)).toBe(expected);
  });

  it("converts apple milliseconds to unix milliseconds", () => {
    const date = Date.UTC(2024, 6, 4, 18, 5, 30, 250);
    const appleMs = toAppleUnits(date, 1e3);
    expect(appleEpochToUnixMs(appleMs)).toBe(date);
  });

  it("converts apple microseconds to unix milliseconds", () => {
    const date = Date.UTC(2023, 10, 5, 6, 30, 0, 0);
    const appleMicro = toAppleUnits(date, 1e6);
    expect(appleEpochToUnixMs(appleMicro)).toBe(date);
  });

  it("converts apple nanoseconds to unix milliseconds", () => {
    const date = Date.UTC(2023, 2, 12, 10, 0, 0, 0);
    const appleNano = toAppleUnits(date, 1e9);
    expect(appleEpochToUnixMs(appleNano)).toBe(date);
  });

  it("rounds to nearest millisecond for fractional conversions", () => {
    const date = Date.UTC(2023, 2, 12, 10, 0, 0, 123);
    const appleMicro = Math.round((date / 1000 - APPLE_EPOCH_SEC) * 1e6 + 0.4);
    expect(appleEpochToUnixMs(appleMicro)).toBe(date);
  });

  it("handles ambiguous mid-range values by treating as milliseconds", () => {
    const date = Date.UTC(2022, 9, 30, 23, 15, 30, 0);
    const appleMs = toAppleUnits(date, 1e3);
    const ambiguous = appleMs; // falls into 1e9..1e12 range
    expect(appleEpochToUnixMs(ambiguous)).toBe(date);
  });
});
