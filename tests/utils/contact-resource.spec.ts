import { describe, expect, test } from "vitest";

import {
  buildContactDescription,
  buildContactPayload,
  decodeContactResourceId,
  encodeContactResourceId,
  selectPrimary,
  toContactResourceData,
} from "../../src/utils/contact-resource.js";

describe("contact resource helpers", () => {
  test("encode/decode round trip preserves trimmed values", () => {
    const data = toContactResourceData({
      name: "Ada Lovelace",
      phones: ["  +1 234 567 8901  ", ""],
      emails: [" lovelace@example.com ", "  "],
    });
    const encoded = encodeContactResourceId(data);
    const decoded = decodeContactResourceId(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded).toEqual({
      name: "Ada Lovelace",
      phones: ["+1 234 567 8901"],
      emails: ["lovelace@example.com"],
    });
  });

  test("selectPrimary returns the first non-empty string", () => {
    expect(selectPrimary(["", "  ", "first", "second"])).toBe("first");
    expect(selectPrimary(["  ", "\n"])).toBeNull();
  });

  test("buildContactDescription summarizes phone and email counts", () => {
    const data = {
      name: "Ada Lovelace",
      phones: ["+1 234"],
      emails: ["ada@example.com", "ada@calc.org"],
    };
    expect(buildContactDescription(data)).toBe("1 phone • 2 emails");
    expect(buildContactDescription({ name: "Nobody", phones: [], emails: [] })).toBe("macOS Contacts entry");
  });

  test("buildContactPayload surfaces primary entries and resource id", () => {
    const data = {
      name: "Ada Lovelace",
      phones: ["+1 234", "+1 345"],
      emails: ["ada@example.com"],
    };
    const payload = buildContactPayload(data, "id123");
    expect(payload.name).toBe("Ada Lovelace");
    expect(payload.primary_phone).toBe("+1 234");
    expect(payload.primary_email).toBe("ada@example.com");
    expect(payload.resource_id).toBe("id123");
    expect(payload.phones).toEqual(data.phones);
    expect(payload.emails).toEqual(data.emails);
    expect(typeof payload.generated_at).toBe("string");
  });
});
