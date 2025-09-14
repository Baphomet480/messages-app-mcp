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
  // Use an AppleScript handler to safely receive argv from osascript, avoiding manual string escaping
  const script = `
on run argv
  set theRecipient to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    set svc to missing value
    try
      set svc to first service whose service type is iMessage
    on error
      try
        set svc to first service whose service type is SMS
      end try
    end try
    if svc is missing value then error "No Messages service (iMessage/SMS) available"
    set theChat to make new text chat with properties {service:svc, participants:{theRecipient}}
    send theText to theChat
  end tell
end run`;

  await runAppleScriptInline(script, [recipient, text]);
}

