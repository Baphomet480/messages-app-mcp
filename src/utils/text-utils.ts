const REPLACEMENT_CHARS_REGEX = /[\uFFFC\uFFFD]/g;
const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LINE_SEP_REGEX = /[\u2028\u2029]/g;

const GSM_BASIC_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u0020!\"#¤%&'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED_CHARS = "^{}\\[~]|€";

const GSM_BASIC_SET = new Set(Array.from(GSM_BASIC_CHARS));
const GSM_EXTENDED_SET = new Set(Array.from(GSM_EXTENDED_CHARS));

export type SegmentEncoding = "gsm-7" | "ucs-2";

export type SegmentInfo = {
  encoding: SegmentEncoding;
  segments: number;
  unitCount: number;
  segmentSize: number;
};

function countGsmUnits(text: string): number | null {
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC_SET.has(ch)) {
      units += 1;
    } else if (GSM_EXTENDED_SET.has(ch)) {
      units += 2;
    } else {
      return null;
    }
  }
  return units;
}

export function estimateSegmentInfo(text: string): SegmentInfo {
  if (!text) {
    return {
      encoding: "gsm-7",
      segments: 0,
      unitCount: 0,
      segmentSize: 160,
    };
  }
  const gsmUnits = countGsmUnits(text);
  if (gsmUnits != null) {
    const singleLimit = 160;
    const multiLimit = 153;
    const segmentSize = gsmUnits <= singleLimit ? singleLimit : multiLimit;
    return {
      encoding: "gsm-7",
      segments: Math.ceil(gsmUnits / segmentSize),
      unitCount: gsmUnits,
      segmentSize,
    };
  }
  const codePoints = Array.from(text);
  const total = codePoints.length;
  const singleLimit = 70;
  const multiLimit = 67;
  const segmentSize = total <= singleLimit ? singleLimit : multiLimit;
  return {
    encoding: "ucs-2",
    segments: Math.ceil(total / segmentSize),
    unitCount: total,
    segmentSize,
  };
}

function tryNormalize(text: string): string {
  try {
    return text.normalize("NFC");
  } catch {
    return text;
  }
}

export function normalizeMessageText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const normalized = tryNormalize(input);
  const cleaned = normalized
    .replace(CONTROL_CHARS_REGEX, "")
    .replace(LINE_SEP_REGEX, "\n");
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const withoutReplacement = collapsed.replace(REPLACEMENT_CHARS_REGEX, "").trim();
  if (!withoutReplacement) return null;
  return withoutReplacement;
}

export function truncateForLog(value: string | null | undefined, max = 120): string | null {
  const normalized = normalizeMessageText(value);
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function extractLongestPrintable(buffer: Buffer): string | null {
  let best = "";
  let current = "";
  const flush = () => {
    const candidate = current.trim();
    if (candidate.length > best.length) best = candidate;
    current = "";
  };
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if ((byte >= 0x20 && byte <= 0x7E) || byte === 0x0A || byte === 0x0D || byte === 0x09) {
      const ch = byte === 0x0A || byte === 0x0D || byte === 0x09 ? " " : String.fromCharCode(byte);
      current += ch;
    } else {
      flush();
    }
  }
  flush();
  if (!best) return null;
  return best.replace(/^[+=\s]+/, "").trim() || null;
}

export function normalizeParsedText(input: string | null | undefined): string | null {
  return normalizeMessageText(input);
}
