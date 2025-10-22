import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import { stat, mkdtemp, writeFile, rm } from "node:fs/promises";

const OSASCRIPT_MODE = (process.env.MESSAGES_MCP_OSASCRIPT_MODE ?? "file").toLowerCase();

function execOsaScript(commandArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", commandArgs, {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`osascript failed: ${stderr || error.message}`);
        reject(err);
        return;
      }
      resolve(stdout.toString().trim());
    });
  });
}

export async function runAppleScriptInline(script: string, args: string[] = []): Promise<string> {
  if (OSASCRIPT_MODE !== "inline") {
    const tempDir = await mkdtemp(join(tmpdir(), "messages-mcp-osa-"));
    const scriptPath = join(tempDir, "script.applescript");
    try {
      await writeFile(scriptPath, script, { encoding: "utf8" });
      return await execOsaScript([scriptPath, ...args]);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return execOsaScript(["-l", "AppleScript", "-e", script, ...args]);
}

type TargetMode = "recipient" | "chat";

export type SendTarget = {
  recipient?: string;
  chatGuid?: string;
  chatName?: string;
};

const SEND_PAYLOAD_SCRIPT = `use framework "Foundation"
use scripting additions

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
        set fallbackBuddy to my locateRecipientBuddy(targetValue)
        if fallbackBuddy is not missing value then
          try
            if class of fallbackBuddy is buddy then set theTarget to fallbackBuddy
          end try
        end if
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
        try
          set messageText to messageText as Unicode text
        end try
        send (messageText as Unicode text) to theTarget
      else
        error "Unsupported payload kind"
      end if
    end timeout
  end tell
end run

on readTextFile(posixPath)
  try
    set fileURL to current application's NSURL's fileURLWithPath:posixPath
    set {theString, readError} to current application's NSString's stringWithContentsOfURL:fileURL encoding:(current application's NSUTF8StringEncoding) |error|:(reference)
    if theString is missing value then error (readError's localizedDescription() as string)
    return theString as Unicode text
  on error errMsg number errNum
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
    set rcsService to missing value
    set imAccounts to {}
    set smsAccounts to {}
    set rcsAccounts to {}
    try
      set imService to first service whose service type is iMessage
    end try
    try
      set smsService to first service whose service type is SMS
    end try
    try
      set rcsService to first service whose service type is RCS
    end try
    try
      set imAccounts to every account whose service type is iMessage
    end try
    try
      set smsAccounts to every account whose service type is SMS
    end try
    try
      set rcsAccounts to every account whose service type is RCS
    end try

    if imService is missing value and smsService is missing value and rcsService is missing value then
      error "No Messages services available. Sign in to iMessage or enable Text Message Forwarding/RCS on your iPhone."
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
      if rcsService is not missing value then set end of candidates to rcsService
    else
      if imService is not missing value then set end of candidates to imService
      if smsService is not missing value then set end of candidates to smsService
      if rcsService is not missing value then set end of candidates to rcsService
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
      repeat with ac in rcsAccounts
        set end of acctCandidates to ac
      end repeat
    else
      repeat with ac in imAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in smsAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in rcsAccounts
        set end of acctCandidates to ac
      end repeat
    end if

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

on locateRecipientBuddy(theRecipient)
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
    set rcsService to missing value
    set imAccounts to {}
    set smsAccounts to {}
    set rcsAccounts to {}
    try
      set imService to first service whose service type is iMessage
    end try
    try
      set smsService to first service whose service type is SMS
    end try
    try
      set rcsService to first service whose service type is RCS
    end try
    try
      set imAccounts to every account whose service type is iMessage
    end try
    try
      set smsAccounts to every account whose service type is SMS
    end try
    try
      set rcsAccounts to every account whose service type is RCS
    end try

    if imService is missing value and smsService is missing value and rcsService is missing value then
      return missing value
    end if

    set candidates to {}
    if isEmail then
      if imService is missing value then
        return missing value
      end if
      set end of candidates to imService
    else if looksPhone then
      if imService is not missing value then set end of candidates to imService
      if smsService is not missing value then set end of candidates to smsService
      if rcsService is not missing value then set end of candidates to rcsService
    else
      if imService is not missing value then set end of candidates to imService
      if smsService is not missing value then set end of candidates to smsService
      if rcsService is not missing value then set end of candidates to rcsService
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
      repeat with ac in rcsAccounts
        set end of acctCandidates to ac
      end repeat
    else
      repeat with ac in imAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in smsAccounts
        set end of acctCandidates to ac
      end repeat
      repeat with ac in rcsAccounts
        set end of acctCandidates to ac
      end repeat
    end if

    repeat with ac in acctCandidates
      try
        set participantRef to participant id theRecipient of ac
        return participantRef
      end try
    end repeat

    repeat with svc in candidates
      try
        set buddyRef to buddy theRecipient of svc
        return buddyRef
      on error
        try
          set buddyRef2 to buddy id theRecipient of svc
          return buddyRef2
        end try
      end try
    end repeat
  end tell

  return missing value
end locateRecipientBuddy
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

const MESSAGES_COMMAND_SCRIPT = `use framework "Foundation"
use scripting additions

on run argv
  if (count of argv) < 1 then error "Command is required."
  set command to item 1 of argv
  set argList to {}
  if (count of argv) > 1 then set argList to items 2 thru -1 of argv

  if command is "list_accounts" then
    return my encodeJson(my commandListAccounts())
  else if command is "list_participants" then
    set filterText to ""
    if (count of argList) ≥ 1 then set filterText to item 1 of argList
    return my encodeJson(my commandListParticipants(filterText))
  else if command is "list_file_transfers" then
    set includeFinished to false
    if (count of argList) ≥ 1 then
      set includeFinished to (item 1 of argList) is "true"
    end if
    set limitCount to 0
    if (count of argList) ≥ 2 then
      try
        set limitCount to item 2 of argList as integer
      end try
    end if
    return my encodeJson(my commandListFileTransfers(includeFinished, limitCount))
  else if command is "accept_file_transfer" then
    if (count of argList) < 1 then error "Transfer id is required."
    set transferId to item 1 of argList
    return my encodeJson(my commandAcceptFileTransfer(transferId))
  else if command is "login_accounts" then
    return my encodeJson(my commandLoginAccounts())
  else if command is "logout_accounts" then
    return my encodeJson(my commandLogoutAccounts())
  else if command is "services_snapshot" then
    return my encodeJson(my commandServicesSnapshot())
  else
    error "Unknown Messages command: " & command
  end if
end run

on encodeJson(obj)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:obj options:0 |error|:(missing value)
  if jsonData is missing value then error "Unable to encode Messages payload."
  set jsonString to current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)
  return jsonString as string
end encodeJson

on commandListAccounts()
  set resultArray to current application's NSMutableArray's array()
  tell application "Messages"
    repeat with acc in accounts
      set recordDict to current application's NSMutableDictionary's dictionary()
      recordDict's setObject:(my safeText(id of acc)) forKey:"id"
      recordDict's setObject:(my safeText(service type of acc)) forKey:"service_type"
      recordDict's setObject:(my safeText(description of acc)) forKey:"description"
      recordDict's setObject:(my safeText(connection status of acc)) forKey:"connection_status"
      recordDict's setObject:(current application's NSNumber's numberWithBool:(my safeBool(enabled of acc))) forKey:"enabled"
      resultArray's addObject:recordDict
    end repeat
  end tell
  return resultArray
end commandListAccounts

on commandListParticipants(filterText)
  set normalizedFilter to ""
  if filterText is not missing value and filterText is not "" then
    set normalizedFilter to my lowerText(filterText)
  end if

  set resultArray to current application's NSMutableArray's array()
  tell application "Messages"
    repeat with p in participants
      set handleText to my safeText(handle of p)
      set nameText to my safeText(name of p)
      set firstNameText to my safeText(first name of p)
      set lastNameText to my safeText(last name of p)
      set fullNameText to my safeText(full name of p)
      set accountService to ""
      try
        set theAccount to account of p
        if theAccount is not missing value then set accountService to my safeText(service type of theAccount)
      end try

      set matchesFilter to true
      if normalizedFilter is not "" then
        set joined to my lowerText(handleText & " " & nameText & " " & firstNameText & " " & lastNameText & " " & fullNameText & " " & accountService)
        if joined does not contain normalizedFilter then set matchesFilter to false
      end if

      if matchesFilter then
        set recordDict to current application's NSMutableDictionary's dictionary()
        recordDict's setObject:(my safeText(id of p)) forKey:"id"
        recordDict's setObject:handleText forKey:"handle"
        recordDict's setObject:nameText forKey:"name"
        recordDict's setObject:firstNameText forKey:"first_name"
        recordDict's setObject:lastNameText forKey:"last_name"
        recordDict's setObject:fullNameText forKey:"full_name"
        recordDict's setObject:accountService forKey:"account_service_type"
        resultArray's addObject:recordDict
      end if
    end repeat
  end tell
  return resultArray
end commandListParticipants

on commandListFileTransfers(includeFinished, limitCount)
  set isoFormatter to current application's NSDateFormatter's alloc()'s init()
  isoFormatter's setLocale:(current application's NSLocale's localeWithLocaleIdentifier:"en_US_POSIX")
  isoFormatter's setDateFormat:"yyyy-MM-dd'T'HH:mm:ssXXX"
  isoFormatter's setTimeZone:(current application's NSTimeZone's timeZoneForSecondsFromGMT:0)

  set resultArray to current application's NSMutableArray's array()
  set collectedCount to 0

  tell application "Messages"
    repeat with ft in file transfers
      set statusText to my safeText(transfer status of ft)
      if includeFinished or statusText is not "finished" then
        set recordDict to current application's NSMutableDictionary's dictionary()
        recordDict's setObject:(my safeText(id of ft)) forKey:"id"
        recordDict's setObject:(my safeText(name of ft)) forKey:"name"
        recordDict's setObject:(my safeText(direction of ft)) forKey:"direction"
        recordDict's setObject:statusText forKey:"transfer_status"

        set filePathString to ""
        try
          set filePathString to POSIX path of (file path of ft)
        end try
        recordDict's setObject:filePathString forKey:"file_path"

        set sizeValue to my safeInteger(file size of ft)
        if sizeValue is missing value then
          recordDict's setObject:(current application's NSNull's null()) forKey:"file_size"
        else
          recordDict's setObject:(current application's NSNumber's numberWithLongLong:sizeValue) forKey:"file_size"
        end if

        set progressValue to my safeInteger(file progress of ft)
        if progressValue is missing value then
          recordDict's setObject:(current application's NSNull's null()) forKey:"file_progress"
        else
          recordDict's setObject:(current application's NSNumber's numberWithLongLong:progressValue) forKey:"file_progress"
        end if

        set startedIso to ""
        set startedUnix to missing value
        try
          set startedDate to started of ft
          if startedDate is not missing value then
            set startedUnix to startedDate's timeIntervalSince1970()
            set startedIso to (isoFormatter's stringFromDate:startedDate) as string
          end if
        end try
        if startedUnix is missing value then
          recordDict's setObject:(current application's NSNull's null()) forKey:"started_unix"
        else
          recordDict's setObject:(current application's NSNumber's numberWithDouble:startedUnix) forKey:"started_unix"
        end if
        recordDict's setObject:startedIso forKey:"started_iso"

        set accountServiceType to ""
        set accountIdText to ""
        try
          set theAccount to account of ft
          if theAccount is not missing value then
            set accountServiceType to my safeText(service type of theAccount)
            set accountIdText to my safeText(id of theAccount)
          end if
        end try
        recordDict's setObject:accountServiceType forKey:"account_service_type"
        recordDict's setObject:accountIdText forKey:"account_id"

        set participantHandle to ""
        set participantName to ""
        try
          set theParticipant to participant of ft
          if theParticipant is not missing value then
            set participantHandle to my safeText(handle of theParticipant)
            set participantName to my safeText(name of theParticipant)
          end if
        end try
        recordDict's setObject:participantHandle forKey:"participant_handle"
        recordDict's setObject:participantName forKey:"participant_name"

        resultArray's addObject:recordDict
        set collectedCount to collectedCount + 1
        if limitCount > 0 and collectedCount ≥ limitCount then exit repeat
      end if
    end repeat
  end tell

  return resultArray
end commandListFileTransfers

on commandAcceptFileTransfer(transferId)
  set isoFormatter to current application's NSDateFormatter's alloc()'s init()
  isoFormatter's setLocale:(current application's NSLocale's localeWithLocaleIdentifier:"en_US_POSIX")
  isoFormatter's setDateFormat:"yyyy-MM-dd'T'HH:mm:ssXXX"
  isoFormatter's setTimeZone:(current application's NSTimeZone's timeZoneForSecondsFromGMT:0)

  set recordDict to current application's NSMutableDictionary's dictionary()
  tell application "Messages"
    set matchedTransfer to missing value
    repeat with ft in file transfers
      try
        if (id of ft as text) is transferId then
          set matchedTransfer to ft
          exit repeat
        end if
      end try
    end repeat

    if matchedTransfer is missing value then
      error "No file transfer found with id " & transferId
    end if

    set acceptError to missing value
    set acceptedFlag to true
    try
      accept matchedTransfer
    on error errMsg
      set acceptError to errMsg as text
      set acceptedFlag to false
    end try

    recordDict's setObject:transferId forKey:"id"
    recordDict's setObject:(my safeText(name of matchedTransfer)) forKey:"name"
    recordDict's setObject:(my safeText(direction of matchedTransfer)) forKey:"direction"
    recordDict's setObject:(my safeText(transfer status of matchedTransfer)) forKey:"transfer_status"

    set filePathString to ""
    try
      set filePathString to POSIX path of (file path of matchedTransfer)
    end try
    recordDict's setObject:filePathString forKey:"file_path"

    set sizeValue to my safeInteger(file size of matchedTransfer)
    if sizeValue is missing value then
      recordDict's setObject:(current application's NSNull's null()) forKey:"file_size"
    else
      recordDict's setObject:(current application's NSNumber's numberWithLongLong:sizeValue) forKey:"file_size"
    end if

    set progressValue to my safeInteger(file progress of matchedTransfer)
    if progressValue is missing value then
      recordDict's setObject:(current application's NSNull's null()) forKey:"file_progress"
    else
      recordDict's setObject:(current application's NSNumber's numberWithLongLong:progressValue) forKey:"file_progress"
    end if

    set startedIso to ""
    set startedUnix to missing value
    try
      set startedDate to started of matchedTransfer
      if startedDate is not missing value then
        set startedUnix to startedDate's timeIntervalSince1970()
        set startedIso to (isoFormatter's stringFromDate:startedDate) as string
      end if
    end try
    if startedUnix is missing value then
      recordDict's setObject:(current application's NSNull's null()) forKey:"started_unix"
    else
      recordDict's setObject:(current application's NSNumber's numberWithDouble:startedUnix) forKey:"started_unix"
    end if
    recordDict's setObject:startedIso forKey:"started_iso"

    set accountServiceType to ""
    set accountIdText to ""
    try
      set theAccount to account of matchedTransfer
      if theAccount is not missing value then
        set accountServiceType to my safeText(service type of theAccount)
        set accountIdText to my safeText(id of theAccount)
      end if
    end try
    recordDict's setObject:accountServiceType forKey:"account_service_type"
    recordDict's setObject:accountIdText forKey:"account_id"

    set participantHandle to ""
    set participantName to ""
    try
      set theParticipant to participant of matchedTransfer
      if theParticipant is not missing value then
        set participantHandle to my safeText(handle of theParticipant)
        set participantName to my safeText(name of theParticipant)
      end if
    end try
    recordDict's setObject:participantHandle forKey:"participant_handle"
    recordDict's setObject:participantName forKey:"participant_name"

    recordDict's setObject:(acceptedFlag as boolean) forKey:"accepted"
    if acceptError is missing value then
      recordDict's setObject:"" forKey:"error"
    else
      recordDict's setObject:acceptError forKey:"error"
    end if
  end tell

  return recordDict
end commandAcceptFileTransfer

on commandLoginAccounts()
  tell application "Messages"
    log in
  end tell
  set recordDict to current application's NSMutableDictionary's dictionary()
  recordDict's setObject:(current application's NSNumber's numberWithBool:true) forKey:"ok"
  recordDict's setObject:"OK" forKey:"message"
  return recordDict
end commandLoginAccounts

on commandLogoutAccounts()
  tell application "Messages"
    log out
  end tell
  set recordDict to current application's NSMutableDictionary's dictionary()
  recordDict's setObject:(current application's NSNumber's numberWithBool:true) forKey:"ok"
  recordDict's setObject:"OK" forKey:"message"
  return recordDict
end commandLogoutAccounts

on commandServicesSnapshot()
  set servicesArray to current application's NSMutableArray's array()
  set accountsArray to current application's NSMutableArray's array()

  tell application "Messages"
    try
      repeat with svc in services
        servicesArray's addObject:(my safeText(service type of svc))
      end repeat
    end try
    try
      repeat with acc in accounts
        accountsArray's addObject:(my safeText(service type of acc))
      end repeat
    end try
  end tell

  set resultDict to current application's NSMutableDictionary's dictionary()
  resultDict's setObject:servicesArray forKey:"services"
  resultDict's setObject:accountsArray forKey:"accounts"
  return resultDict
end commandServicesSnapshot

on safeText(possibleValue)
  try
    if possibleValue is missing value then return ""
    return possibleValue as text
  on error
    return ""
  end try
end safeText

on safeBool(possibleValue)
  try
    return possibleValue as boolean
  on error
    return false
  end try
end safeBool

on safeInteger(possibleValue)
  try
    if possibleValue is missing value then return missing value
    return possibleValue as integer
  on error
    return missing value
  end try
end safeInteger

on lowerText(possibleValue)
  try
    if possibleValue is missing value then return ""
    return (possibleValue as text)'s lowercaseString()
  on error
    return ""
  end try
end lowerText
`;

async function runMessagesCommand<T = unknown>(command: string, args: string[] = []): Promise<T> {
  const output = await runAppleScriptInline(MESSAGES_COMMAND_SCRIPT, [command, ...args]).catch((error) => {
    throw new Error(`Messages command '${command}' failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const normalized = output && output.length ? output : "null";
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    throw new Error(`Unable to parse JSON for '${command}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type MessagesAccountInfo = {
  id: string;
  service_type: string;
  description: string;
  connection_status: string;
  enabled: boolean;
};

export async function listMessagesAccounts(): Promise<MessagesAccountInfo[]> {
  const data = await runMessagesCommand<unknown[] | null>("list_accounts");
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry && typeof entry === "object" ? entry : {}))
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        id: asString(record.id),
        service_type: asString(record.service_type),
        description: asString(record.description),
        connection_status: asString(record.connection_status),
        enabled: asBoolean(record.enabled),
      } satisfies MessagesAccountInfo;
    })
    .filter((entry) => entry.id || entry.service_type || entry.description || entry.connection_status);
}

export type MessagesParticipantInfo = {
  id: string;
  handle: string;
  name: string;
  first_name: string;
  last_name: string;
  full_name: string;
  account_service_type: string;
};

export async function listMessagesParticipants(filter?: string): Promise<MessagesParticipantInfo[]> {
  const args: string[] = [];
  if (filter && filter.trim().length > 0) {
    args.push(filter.trim());
  }
  const data = await runMessagesCommand<unknown[] | null>("list_participants", args);
  if (!Array.isArray(data)) return [];
  return data.map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: asString(record.id),
      handle: asString(record.handle),
      name: asString(record.name),
      first_name: asString(record.first_name),
      last_name: asString(record.last_name),
      full_name: asString(record.full_name),
      account_service_type: asString(record.account_service_type),
    } satisfies MessagesParticipantInfo;
  });
}

export type MessagesFileTransferInfo = {
  id: string;
  name: string;
  direction: string;
  transfer_status: string;
  file_path: string;
  file_size: number | null;
  file_progress: number | null;
  started_unix: number | null;
  started_iso: string;
  account_service_type: string;
  account_id: string;
  participant_handle: string;
  participant_name: string;
};

export async function listMessagesFileTransfers(options: { includeFinished?: boolean; limit?: number } = {}): Promise<MessagesFileTransferInfo[]> {
  const includeFinished = options.includeFinished ?? false;
  const limit = options.limit ?? 0;
  const args = [includeFinished ? "true" : "false"];
  if (limit && Number.isFinite(limit) && limit > 0) {
    args.push(String(Math.trunc(limit)));
  }
  const data = await runMessagesCommand<unknown[] | null>("list_file_transfers", args);
  if (!Array.isArray(data)) return [];
  return data.map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: asString(record.id),
      name: asString(record.name),
      direction: asString(record.direction),
      transfer_status: asString(record.transfer_status),
      file_path: asString(record.file_path),
      file_size: asNumberOrNull(record.file_size),
      file_progress: asNumberOrNull(record.file_progress),
      started_unix: asNumberOrNull(record.started_unix),
      started_iso: asString(record.started_iso),
      account_service_type: asString(record.account_service_type),
      account_id: asString(record.account_id),
      participant_handle: asString(record.participant_handle),
      participant_name: asString(record.participant_name),
    } satisfies MessagesFileTransferInfo;
  });
}

export type MessagesFileTransferAcceptance = MessagesFileTransferInfo & {
  accepted: boolean;
  error: string;
};

export async function acceptMessagesFileTransfer(id: string): Promise<MessagesFileTransferAcceptance> {
  if (!id || !id.trim()) {
    throw new Error("Transfer id must be provided.");
  }
  const payload = await runMessagesCommand<Record<string, unknown> | null>("accept_file_transfer", [id.trim()]);
  if (!payload) {
    throw new Error("No payload returned from AppleScript during file transfer acceptance.");
  }
  return {
    id: asString(payload.id) || id,
    name: asString(payload.name),
    direction: asString(payload.direction),
    transfer_status: asString(payload.transfer_status),
    file_path: asString(payload.file_path),
    file_size: asNumberOrNull(payload.file_size),
    file_progress: asNumberOrNull(payload.file_progress),
    started_unix: asNumberOrNull(payload.started_unix),
    started_iso: asString(payload.started_iso),
    account_service_type: asString(payload.account_service_type),
    account_id: asString(payload.account_id),
    participant_handle: asString(payload.participant_handle),
    participant_name: asString(payload.participant_name),
    accepted: asBoolean(payload.accepted),
    error: asString(payload.error),
  } satisfies MessagesFileTransferAcceptance;
}

export type MessagesServiceSnapshot = {
  services: string[];
  accounts: string[];
};

export async function getMessagesServiceSnapshot(): Promise<MessagesServiceSnapshot> {
  const payload = await runMessagesCommand<Record<string, unknown> | null>("services_snapshot");
  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => asString(entry).trim())
      .filter((entry) => entry.length > 0);
  };
  return {
    services: toStringArray(payload?.services),
    accounts: toStringArray(payload?.accounts),
  } satisfies MessagesServiceSnapshot;
}

export async function loginMessagesAccounts(): Promise<void> {
  const payload = await runMessagesCommand<Record<string, unknown> | null>("login_accounts");
  if (!payload || !asBoolean(payload.ok)) {
    const message = asString(payload?.message) || "Failed to log in Messages accounts.";
    throw new Error(message);
  }
}

export async function logoutMessagesAccounts(): Promise<void> {
  const payload = await runMessagesCommand<Record<string, unknown> | null>("logout_accounts");
  if (!payload || !asBoolean(payload.ok)) {
    const message = asString(payload?.message) || "Failed to log out Messages accounts.";
    throw new Error(message);
  }
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
