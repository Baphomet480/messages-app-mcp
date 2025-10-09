import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import { stat, mkdtemp, writeFile, rm } from "node:fs/promises";

export function runAppleScriptInline(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/osascript", ["-l", "AppleScript", "-e", script, ...args], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`osascript failed: ${stderr || error.message}`);
        return reject(err);
      }
      resolve(stdout.toString().trim());
    });
  });
}

type TargetMode = "recipient" | "chat";

export type SendTarget = {
  recipient?: string;
  chatGuid?: string;
  chatName?: string;
};

const SEND_PAYLOAD_SCRIPT = `
on run argv
  if (count of argv) < 4 then error "Missing arguments"
  set payloadKind to item 1 of argv
  set targetMode to item 2 of argv
  set targetValue to item 3 of argv
  set payloadValue to item 4 of argv
  set captionText to ""
  if payloadKind is "file" then
    if (count of argv) >= 5 then set captionText to item 5 of argv
  end if

  if targetMode is not in {"recipient", "chat"} then error "Invalid target mode"
  if payloadKind is not in {"text", "text_path", "file"} then error "Invalid payload kind"

  set theFile to missing value
  if payloadKind is "file" then
    set theFile to POSIX file payloadValue
  end if

  tell application "Messages"
    with timeout of 30 seconds
      set theTarget to missing value
      if targetMode is "chat" then
        set theTarget to my locateChat(targetValue)
      else
        set theTarget to my locateRecipient(targetValue)
      end if

      if theTarget is missing value then
        if targetMode is "chat" then
          error "Unable to find chat with provided identifier."
        else
          error "Unable to resolve recipient; no account can send to this target."
        end if
      end if

      if payloadKind is "file" then
        if captionText is not "" then
          try
            send captionText to theTarget
            delay 0.2
          end try
        end if
        send theFile to theTarget
      else if payloadKind is "text_path" or payloadKind is "text" then
        set messageText to payloadValue
        if payloadKind is "text_path" then
          set messageText to my readTextFile(payloadValue)
        end if
        send messageText to theTarget
      else
        error "Unsupported payload kind"
      end if
    end timeout
  end tell
end run

on readTextFile(posixPath)
  set theFile to POSIX file posixPath
  try
    set handleRef to open for access theFile without write permission
    set theText to read handleRef as string
    close access handleRef
    return theText
  on error errMsg number errNum
    try
      close access theFile
    end try
    error "Failed to read temporary text payload: " & errMsg
  end try
end readTextFile

on locateChat(chatKey)
  if chatKey is missing value or chatKey is "" then return missing value
  tell application "Messages"
    try
      set directChat to chat id chatKey
      return directChat
    end try
    repeat with existingChat in chats
      try
        if (id of existingChat as string) is chatKey then return existingChat
      end try
    end repeat
    repeat with existingChat in chats
      try
        if (name of existingChat as string) is chatKey then return existingChat
      end try
    end repeat
  end tell
  return missing value
end locateChat

on locateRecipient(theRecipient)
  if theRecipient is missing value or theRecipient is "" then return missing value

  set isEmail to false
  set looksPhone to false
  try
    if theRecipient contains "@" then set isEmail to true
  end try
  if isEmail is false then
    try
      set firstChar to (characters 1 thru 1 of theRecipient) as string
      if firstChar is "+" then set looksPhone to true
    end try
  end if

  tell application "Messages"
    set imService to missing value
    set smsService to missing value
    set imAccounts to {}
    set smsAccounts to {}
    try
      set imService to first service whose service type is iMessage
    end try
    try
      set smsService to first service whose service type is SMS
    end try
    try
      set imAccounts to every account whose service type is iMessage
    end try
    try
      set smsAccounts to every account whose service type is SMS
    end try

    if imService is missing value and smsService is missing value then
      error "No Messages services available. Sign in to iMessage or enable Text Message Forwarding on your iPhone."
    end if

    set candidates to {}
    if isEmail then
      if imService is missing value then
        error "Recipient looks like an email, but iMessage is not available on this Mac. Sign in to iMessage and try again."
      end if
      set end of candidates to imService
    else if looksPhone then
      if imService is not missing value then set end of candidates to imService
      if smsService is not missing value then set end of candidates to smsService
    else
      if imService is not missing value then set end of candidates to imService
      if smsService is not missing value then set end of candidates to smsService
    end if

    set acctCandidates to {}
    if isEmail then
      repeat with ac in imAccounts
        set end of acctCandidates to ac
      end repeat
    else if looksPhone then
      repeat with ac in imAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in smsAccounts
        set end of acctCandidates to ac
      end repeat
    else
      repeat with ac in imAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in smsAccounts
        set end of acctCandidates to ac
      end repeat
    end if

    repeat with svc in candidates
      try
        set existingChats to (every chat whose service is svc)
        repeat with c in existingChats
          set parts to {}
          try
            set parts to participants of c
          end try
          if parts contains theRecipient then return c
        end repeat
      end try
    end repeat

    repeat with ac in acctCandidates
      try
        set theParticipant to participant id theRecipient of ac
        return theParticipant
      end try
    end repeat

    repeat with svc in candidates
      try
        set theParticipant2 to participant id theRecipient of svc
        return theParticipant2
      end try
    end repeat

    repeat with svc in candidates
      try
        set theBuddy to buddy id theRecipient of svc
        return theBuddy
      end try
    end repeat

    repeat with svc in candidates
      try
        set theChat to make new text chat with properties {service:svc, participants:{theRecipient}}
        delay 0.2
        return theChat
      end try
    end repeat
  end tell

  return missing value
end locateRecipient
`;

function resolveSendTarget(target: string | SendTarget): { mode: TargetMode; value: string } {
  if (typeof target === "string") {
    const trimmed = target.trim();
    if (!trimmed) throw new Error("Recipient cannot be empty.");
    return { mode: "recipient", value: trimmed };
  }
  if (target.chatGuid && target.chatGuid.trim()) {
    return { mode: "chat", value: target.chatGuid.trim() };
  }
  if (target.chatName && target.chatName.trim()) {
    return { mode: "chat", value: target.chatName.trim() };
  }
  if (target.recipient && target.recipient.trim()) {
    return { mode: "recipient", value: target.recipient.trim() };
  }
  throw new Error("A recipient, chatGuid, or chatName is required.");
}

async function runSendPayload(
  payloadKind: "text" | "text_path" | "file",
  target: string | SendTarget,
  payload: string,
  caption?: string,
): Promise<void> {
  const { mode, value } = resolveSendTarget(target);
  const args = [payloadKind, mode, value, payload];
  if (payloadKind === "file" && caption && caption.trim().length > 0) {
    args.push(caption);
  }
  await runAppleScriptInline(SEND_PAYLOAD_SCRIPT, args);
}

export async function sendMessageAppleScript(target: string | SendTarget, text: string): Promise<void> {
  if (!text || text.trim().length === 0) {
    throw new Error("Message text must not be empty.");
  }
  const tempDir = await mkdtemp(join(tmpdir(), "messages-mcp-"));
  const payloadPath = join(tempDir, "body.txt");
  try {
    await writeFile(payloadPath, text, { encoding: "utf8" });
    await runSendPayload("text_path", target, payloadPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function expandUserPath(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return resolvePath(homedir(), rawPath.slice(2));
  if (rawPath.startsWith("~")) return resolvePath(homedir(), rawPath.slice(1));
  return rawPath;
}

async function normalizeAttachmentPath(filePath: string): Promise<string> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error("Attachment path must not be empty.");
  }
  const expanded = expandUserPath(filePath.trim());
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(expanded);
  try {
    const stats = await stat(absolute);
    if (!stats.isFile()) {
      throw new Error(`Attachment path is not a file: ${absolute}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Attachment not found at ${absolute}. Ensure the file exists and this process has Full Disk Access.`);
    }
    throw err;
  }
  return absolute;
}

export const MESSAGES_FDA_HINT = "Messages needs Full Disk Access (System Settings → Privacy & Security → Full Disk Access) to send attachments from arbitrary folders.";

export async function sendAttachmentAppleScript(
  target: string | SendTarget,
  filePath: string,
  caption?: string,
): Promise<void> {
  const normalizedPath = await normalizeAttachmentPath(filePath);
  try {
    await runSendPayload("file", target, normalizedPath, caption);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/POSIX file/.test(message) || /\(-1728\)/.test(message)) {
      throw new Error(MESSAGES_FDA_HINT);
    }
    throw err;
  }
}
