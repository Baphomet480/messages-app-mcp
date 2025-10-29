import { getLogger } from "./logger.js";
import { runAppleScriptAsset } from "./applescript.js";

const logger = getLogger();

const CONTACTS_ENABLED = parseEnvBool(process.env.MESSAGES_MCP_CONTACTS, true);
const CACHE_LIMIT = 500;

const contactNameCache = new Map<string, string | null>();
const pendingLookups = new Map<string, Promise<string | null>>();

export type ContactSearchResult = {
  name: string;
  phones: string[];
  emails: string[];
};

function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeHandleKey(handle: string | null | undefined): string | null {
  const trimmed = handle?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function setCacheEntry(key: string, value: string | null): void {
  if (!key) return;
  if (!contactNameCache.has(key) && contactNameCache.size >= CACHE_LIMIT) {
    const firstKey = contactNameCache.keys().next().value as string | undefined;
    if (firstKey) {
      contactNameCache.delete(firstKey);
    }
  }
  contactNameCache.set(key, value);
}

export function contactsFeatureEnabled(): boolean {
  return CONTACTS_ENABLED;
}

export async function resolveContactName(handle: string): Promise<string | null> {
  if (!CONTACTS_ENABLED) return null;
  const key = normalizeHandleKey(handle);
  if (!key) return null;

  if (contactNameCache.has(key)) {
    return contactNameCache.get(key) ?? null;
  }

  if (pendingLookups.has(key)) {
    return pendingLookups.get(key)!;
  }

  const promise = (async () => {
    try {
      const output = await runAppleScriptAsset("contacts.applescript", ["lookup", handle]);
      const name = output?.trim?.() ?? "";
      const resolved = name.length > 0 ? name : null;
      setCacheEntry(key, resolved);
      return resolved;
    } catch (error) {
      logger.warn("contact lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      setCacheEntry(key, null);
      return null;
    } finally {
      pendingLookups.delete(key);
    }
  })();

  pendingLookups.set(key, promise);
  return promise;
}

export async function resolveContactNames(handles: Iterable<string>): Promise<Map<string, string>> {
  const canonicalToHandles = new Map<string, Set<string>>();
  for (const raw of handles) {
    const trimmed = raw?.trim?.() ?? "";
    if (!trimmed) continue;
    const canonical = normalizeHandleKey(trimmed);
    if (!canonical) continue;
    if (!canonicalToHandles.has(canonical)) {
      canonicalToHandles.set(canonical, new Set());
    }
    canonicalToHandles.get(canonical)!.add(trimmed);
  }

  const results = new Map<string, string>();
  const pending: Array<{ canonical: string; sample: string }> = [];
  for (const [canonical, set] of canonicalToHandles.entries()) {
    if (contactNameCache.has(canonical)) {
      const cached = contactNameCache.get(canonical);
      if (cached) {
        for (const handle of set) {
          results.set(handle, cached);
        }
      }
      continue;
    }
    const sample = Array.from(set)[0];
    pending.push({ canonical, sample });
  }

  for (const entry of pending) {
    const name = await resolveContactName(entry.sample);
    if (name) {
      const handles = canonicalToHandles.get(entry.canonical);
      if (handles) {
        for (const handle of handles) {
          results.set(handle, name);
        }
      }
    }
  }

  // Populate from cache for any remaining handles (including those that resolved to null)
  for (const [canonical, set] of canonicalToHandles.entries()) {
    const cached = contactNameCache.get(canonical);
    if (!cached) continue;
    for (const handle of set) {
      if (!results.has(handle)) {
        results.set(handle, cached);
      }
    }
  }

  return results;
}

export async function searchContacts(query: string, limit = 20): Promise<ContactSearchResult[]> {
  if (!CONTACTS_ENABLED) return [];
  const trimmed = query?.trim?.() ?? "";
  const boundedLimit = Math.max(1, Math.min(100, limit));
  try {
    const raw = await runAppleScriptAsset("contacts.applescript", ["search", trimmed, String(boundedLimit)]);
    if (!raw || raw.trim().length === 0) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        return {
          name: coerceString(record.name),
          phones: coerceStringArray(record.phones),
          emails: coerceStringArray(record.emails),
        } satisfies ContactSearchResult;
      })
      .filter((entry): entry is ContactSearchResult => !!entry && entry.name.length > 0);
  } catch (error) {
    logger.warn("contact search failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => coerceString(entry).trim())
    .filter((entry) => entry.length > 0);
}
