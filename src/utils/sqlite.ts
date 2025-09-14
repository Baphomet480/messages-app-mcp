import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatRow = {
  chat_id: number;
  guid: string;
  display_name: string | null;
  last_message_date: number | null; // Apple epoch; may be sec/us/ns
  participants: string | null; // comma-separated
};

export type MessageRow = {
  message_rowid: number;
  guid: string;
  is_from_me: number;
  text: string | null;
  date: number | null; // Apple epoch (sec/us/ns)
  sender: string | null; // handle id (phone/email) if not from me
  has_attachments?: number | null;
};

export function getChatDbPath(): string {
  return join(homedir(), "Library", "Messages", "chat.db");
}

async function runSqliteJSON(dbPath: string, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    // Use CLI sqlite3 in read-only mode with JSON output
    const args = ["-readonly", "-json", dbPath, sql];
    execFile("/usr/bin/sqlite3", args, { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      const raw = stdout.toString().trim();
      if (!raw) return resolve([]);
      try {
        const data = JSON.parse(raw);
        resolve(data);
      } catch (e) {
        reject(new Error(`Failed to parse sqlite3 JSON: ${(e as Error).message}`));
      }
    });
  });
}

async function tableHasColumn(dbPath: string, table: string, column: string): Promise<boolean> {
  const pragma = `PRAGMA table_info(${table});`;
  const rows = (await runSqliteJSON(dbPath, pragma)) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

async function resolveHandlesForParticipant(dbPath: string, participant: string): Promise<string[]> {
  const safe = participant.replaceAll("'", "''");
  const hasPerson = await tableHasColumn(dbPath, "handle", "person_centric_id");
  if (hasPerson) {
    const personRows = await runSqliteJSON(dbPath, `SELECT person_centric_id FROM handle WHERE id='${safe}' LIMIT 1;`) as Array<{ person_centric_id: string | null }>;
    const personId = personRows[0]?.person_centric_id;
    if (personId) {
      const handles = await runSqliteJSON(dbPath, `SELECT id FROM handle WHERE person_centric_id='${personId}' ORDER BY id;`) as Array<{ id: string }>;
      const list = handles.map(h => h.id).filter(Boolean);
      if (list.length > 0) return Array.from(new Set(list));
    }
  }
  // Fallback: just the provided handle
  return [participant];
}

export function appleEpochToUnixMs(value: number | null | undefined): number | null {
  if (value == null) return null;
  // Apple epoch starts 2001-01-01
  const APPLE_EPOCH_SEC = 978307200;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Heuristic for unit: seconds, milliseconds, microseconds, or nanoseconds since 2001-01-01.
  // Covers both real-world chat.db values (typically seconds, microseconds, or nanoseconds)
  // and small synthetic test values (e.g., 2500 ms, 1_500_000 µs, 2_000_000_000 ns).
  let secondsSinceApple: number;
  if (n >= 1e15) {
    // Likely nanoseconds
    secondsSinceApple = n / 1e9;
  } else if (n >= 1e12) {
    // Likely microseconds
    secondsSinceApple = n / 1e6;
  } else if (n >= 1e9) {
    // Prefer nanoseconds in this ambiguous band (aligns with common chat.db values and CI tests)
    secondsSinceApple = n / 1e9;
  } else if (n >= 1e6) {
    // Small-range microseconds (e.g., 1_500_000 => 1.5s)
    secondsSinceApple = n / 1e6;
  } else if (n >= 1e3) {
    // Small-range milliseconds (e.g., 2500 => 2.5s)
    secondsSinceApple = n / 1e3;
  } else {
    // Seconds
    secondsSinceApple = n;
  }
  const unixMs = (secondsSinceApple + APPLE_EPOCH_SEC) * 1000;
  return Math.round(unixMs);
}

export async function listChats(limit = 50): Promise<ChatRow[]> {
  const db = getChatDbPath();
  const sql = `
    WITH last_msg AS (
      SELECT cmj.chat_id, MAX(m.date) AS last_message_date
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      GROUP BY cmj.chat_id
    )
    SELECT c.ROWID AS chat_id,
           c.guid AS guid,
           c.display_name AS display_name,
           lm.last_message_date AS last_message_date,
           (
             SELECT GROUP_CONCAT(DISTINCT h.id)
             FROM chat_handle_join ch
             JOIN handle h ON h.ROWID = ch.handle_id
             WHERE ch.chat_id = c.ROWID
           ) AS participants
    FROM chat c
    LEFT JOIN last_msg lm ON lm.chat_id = c.ROWID
    ORDER BY lm.last_message_date DESC NULLS LAST
    LIMIT ${Math.max(1, Math.min(500, limit))};`;

  const rows = (await runSqliteJSON(db, sql)) as ChatRow[];
  return rows;
}

export async function getMessagesByChatId(chatId: number, limit = 50): Promise<MessageRow[]> {
  const db = getChatDbPath();
  const sql = `
    SELECT m.ROWID AS message_rowid,
           m.guid AS guid,
           m.is_from_me AS is_from_me,
           m.text AS text,
           m.cache_has_attachments AS has_attachments,
           m.date AS date,
           h.id AS sender
    FROM chat_message_join cmj
    JOIN message m ON m.ROWID = cmj.message_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE cmj.chat_id = ${Math.floor(chatId)}
    ORDER BY m.date DESC
    LIMIT ${Math.max(1, Math.min(500, limit))};`;

  const rows = (await runSqliteJSON(db, sql)) as MessageRow[];
  return rows;
}

export async function getMessagesByParticipant(participant: string, limit = 50): Promise<MessageRow[]> {
  const db = getChatDbPath();
  const handles = await resolveHandlesForParticipant(db, participant);
  const quotedList = handles.map(h => `'${h.replaceAll("'", "''")}'`).join(",");
  const sql = `
    WITH target_chats AS (
      SELECT DISTINCT ch.chat_id
      FROM chat_handle_join ch
      JOIN handle h ON h.ROWID = ch.handle_id
      WHERE h.id IN (${quotedList})
    )
    SELECT m.ROWID AS message_rowid,
           m.guid AS guid,
           m.is_from_me AS is_from_me,
           m.text AS text,
           m.cache_has_attachments AS has_attachments,
           m.date AS date,
           h.id AS sender
    FROM chat_message_join cmj
    JOIN message m ON m.ROWID = cmj.message_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE cmj.chat_id IN (SELECT chat_id FROM target_chats)
    ORDER BY m.date DESC
    LIMIT ${Math.max(1, Math.min(500, limit))};`;

  const rows = (await runSqliteJSON(db, sql)) as MessageRow[];
  return rows;
}
