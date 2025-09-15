import { execFile } from "node:child_process";

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

export async function sendMessageAppleScript(recipient: string, text: string): Promise<void> {
  // AppleScript attempts multiple strategies for better reliability across macOS versions:
  // 1) Use existing chat if found
  // 2) Send to buddy on a service
  // 3) Create a new text chat
  const script = `
on run argv
  if (count of argv) < 2 then error "Missing args"
  set theRecipient to item 1 of argv
  set theText to item 2 of argv

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

    -- Build a candidate list honoring the recipient shape
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

    with timeout of 25 seconds
      -- Strategy A: try existing chats first (faster and more reliable on some systems)
      repeat with svc in candidates
        try
          -- Avoid 'text chat' token to sidestep parser quirks on some systems
          set existingChats to (every chat whose service is svc)
          repeat with c in existingChats
            set parts to {}
            try
              set parts to participants of c
            end try
            if parts contains theRecipient then
              try
                send theText to c
                return "OK"
              end try
            end if
          end repeat
        end try
      end repeat

      -- Strategy B: participant-based send via account (Big Sur+)
      if (count of imAccounts) > 0 or (count of smsAccounts) > 0 then
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

        repeat with ac in acctCandidates
          try
            set theParticipant to participant id theRecipient of ac
            send theText to theParticipant
            return "OK"
          end try
        end repeat
      end if

      -- Strategy C: participant-based send via service
      repeat with svc in candidates
        try
          set theParticipant2 to participant id theRecipient of svc
          send theText to theParticipant2
          return "OK"
        end try
      end repeat

      -- Strategy D: buddy-based send (older)
      repeat with svc in candidates
        try
          set theBuddy to buddy id theRecipient of svc
          send theText to theBuddy
          return "OK"
        end try
      end repeat

      -- Strategy E: create a new text chat
      repeat with svc in candidates
        try
          set theChat to make new text chat with properties {service:svc, participants:{theRecipient}}
          -- Sometimes the chat object needs a short delay to settle
          delay 0.2
          send theText to theChat
          return "OK"
        end try
      end repeat

      if isEmail then
        error "Unable to send via iMessage to email recipient. Verify the address is registered with iMessage."
      else if looksPhone then
        error "Unable to send via iMessage or SMS. If the number is not on iMessage, enable Text Message Forwarding for this Mac on your iPhone and try again."
      else
        error "Unable to send: no chat or buddy could be created for this recipient."
      end if
    end timeout
  end tell
end run`;

  await runAppleScriptInline(script, [recipient, text]);
}
