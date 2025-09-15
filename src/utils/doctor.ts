import { execFile } from "node:child_process";
import { runAppleScriptInline } from "./applescript.js";
import { getChatDbPath } from "./sqlite.js";

export type DoctorReport = {
  ok: boolean;
  osascript_available: boolean;
  services: string[];
  accounts: string[];
  iMessage_available: boolean;
  sms_available: boolean;
  sqlite_access: boolean;
  db_path: string;
  notes: string[];
};

export async function runDoctor(): Promise<DoctorReport & { summary: string }> {
  const notes: string[] = [];

  // Check osascript availability by running a trivial script
  let osascript_available = false;
  try {
    await runAppleScriptInline('on run argv\nreturn "OK"\nend run', []);
    osascript_available = true;
  } catch {
    osascript_available = false;
    notes.push("osascript not available or blocked.");
  }

  // Query Messages for services and accounts
  let services: string[] = [];
  let accounts: string[] = [];
  if (osascript_available) {
    try {
      const s = await runAppleScriptInline(
        'on run argv\ntry\n  tell application "Messages"\n    set t to service type of every service\n    return t as string\n  end tell\nend try\nreturn ""\nend run'
      );
      services = s ? s.split(/,\s*/).filter(Boolean) : [];
    } catch {
      notes.push("Unable to query Messages services via AppleScript.");
    }
    try {
      const a = await runAppleScriptInline(
        'on run argv\ntry\n  tell application "Messages"\n    set t to service type of every account\n    return t as string\n  end tell\nend try\nreturn ""\nend run'
      );
      accounts = a ? a.split(/,\s*/).filter(Boolean) : [];
    } catch {
      notes.push("Unable to query Messages accounts via AppleScript.");
    }
  }

  const iMessage_available = services.includes("iMessage") || accounts.includes("iMessage");
  const sms_available = services.includes("SMS") || accounts.includes("SMS");
  const servicesQueried = services.length > 0 || accounts.length > 0;
  if (!servicesQueried) {
    notes.push("Messages services could not be enumerated via AppleScript; sending may still work (as observed). This is a known quirk on some macOS versions.");
  } else {
    if (!iMessage_available) notes.push("iMessage not available: sign in to Messages with your Apple ID.");
    if (!sms_available) notes.push("SMS not available: enable Text Message Forwarding on your iPhone for this Mac.");
  }

  // Check SQLite access to chat.db
  const db_path = getChatDbPath();
  let sqlite_access = false;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/sqlite3",
        ["-readonly", "-json", db_path, "SELECT 1 AS ok;"],
        { timeout: 5000 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve(stdout.toString());
        }
      );
    });
    sqlite_access = /\[\s*{\s*\"ok\"\s*:\s*1\s*}\s*\]/.test(result.trim());
    if (!sqlite_access) notes.push("SQLite read returned unexpected output; Full Disk Access may be required.");
  } catch {
    sqlite_access = false;
    notes.push("Unable to read Messages chat.db. Grant Full Disk Access to your terminal app.");
  }

  if (osascript_available && (servicesQueried ? (!iMessage_available && !sms_available) : false)) {
    notes.push("Messages services not detected. Open Messages and complete setup.");
  }

  const ok = osascript_available && sqlite_access; // do not require service enumeration
  const summary = [
    `osascript: ${osascript_available ? "ok" : "missing"}`,
    `services: ${services.join(", ") || "(none)"}`,
    `accounts: ${accounts.join(", ") || "(none)"}`,
    `iMessage: ${servicesQueried ? (iMessage_available ? "available" : "not available") : "unknown"}`,
    `SMS: ${servicesQueried ? (sms_available ? "available" : "not available") : "unknown"}`,
    `sqlite access: ${sqlite_access ? "ok" : "blocked"} (${db_path})`
  ].join("\n");

  return {
    ok,
    osascript_available,
    services,
    accounts,
    iMessage_available,
    sms_available,
    sqlite_access,
    db_path,
    notes,
    summary,
  };
}
