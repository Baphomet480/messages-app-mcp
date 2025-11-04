import type { ContactSearchResult } from "./contacts.js";

export type ContactResourceData = {
  name: string;
  phones: string[];
  emails: string[];
};

function normalizeList(values: readonly string[]): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => value?.trim?.() ?? "")
    .filter((value) => value.length > 0);
}

export function toContactResourceData(result: ContactSearchResult): ContactResourceData {
  return {
    name: result.name,
    phones: normalizeList(result.phones),
    emails: normalizeList(result.emails),
  };
}

export function encodeContactResourceId(data: ContactResourceData): string {
  const payload = JSON.stringify({
    name: data.name,
    phones: data.phones,
    emails: data.emails,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeContactResourceId(id: string): ContactResourceData | null {
  if (!id || typeof id !== "string") return null;
  try {
    const json = Buffer.from(id, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) return null;
    const phones = Array.isArray(record.phones) ? normalizeList(record.phones as string[]) : [];
    const emails = Array.isArray(record.emails) ? normalizeList(record.emails as string[]) : [];
    return { name, phones, emails };
  } catch {
    return null;
  }
}

export function selectPrimary(values: readonly string[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim?.() ?? "";
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

export function buildContactDescription(data: ContactResourceData): string {
  const parts: string[] = [];
  if (data.phones.length > 0) {
    parts.push(`${data.phones.length} phone${data.phones.length === 1 ? "" : "s"}`);
  }
  if (data.emails.length > 0) {
    parts.push(`${data.emails.length} email${data.emails.length === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) {
    return "macOS Contacts entry";
  }
  return parts.join(" • ");
}

export function buildContactPayload(data: ContactResourceData, resourceId?: string) {
  const primaryPhone = selectPrimary(data.phones);
  const primaryEmail = selectPrimary(data.emails);
  return {
    generated_at: new Date().toISOString(),
    resource_id: resourceId ?? null,
    name: data.name,
    primary_phone: primaryPhone,
    primary_email: primaryEmail,
    phones: data.phones,
    emails: data.emails,
  } as const;
}
