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
       set firstChar to text 1 thru 1 of theRecipient
       if firstChar is "+" then set looksPhone to true
     end try
   end if

   tell application "Messages"
     set imService to missing value
     set smsService to missing value
     -- Discover available services; these 'try' blocks avoid throwing when a service doesn't exist
     try
       set imService to first service whose service type is iMessage
     end try
     try
       set smsService to first service whose service type is SMS
     end try

     if imService is missing value and smsService is missing value then
       error "No Messages services available. Sign in to iMessage or enable Text Message Forwarding on your iPhone."
     end if

     set selectedService to missing value
     if isEmail then
       if imService is not missing value then
         set selectedService to imService
       else
         error "Recipient looks like an email, but iMessage is not available on this Mac. Sign in to iMessage and try again."
       end if
     else if looksPhone then
       if imService is not missing value then
         set selectedService to imService -- prefer iMessage for phone if available; will fallback to SMS on failure
       else if smsService is not missing value then
         set selectedService to smsService
       end if
     else
       -- Unknown handle shape; prefer iMessage if present
       if imService is not missing value then
         set selectedService to imService
       else
         set selectedService to smsService
       end if
     end if

     if selectedService is missing value then
       error "No suitable service available for the recipient."
     end if

     with timeout of 20 seconds
       try
         set theChat to make new text chat with properties {service:selectedService, participants:{theRecipient}}
         send theText to theChat
         return "OK"
       on error errMsg number errNum
         -- If first attempt failed and both services exist, try the other one when reasonable
         if isEmail then
           -- Email cannot be sent via SMS; surface actionable error
           error "Send failed via iMessage for email recipient: " & errMsg
         else if looksPhone then
           if selectedService is imService and smsService is not missing value then
             try
               set fallbackChat to make new text chat with properties {service:smsService, participants:{theRecipient}}
               send theText to fallbackChat
               return "OK"
             on error errMsg2 number errNum2
               error "Send failed via iMessage and SMS. Check iMessage registration for the number or enable Text Message Forwarding. Details: " & errMsg2
             end try
           else if selectedService is smsService and imService is not missing value then
             try
               set fallbackChat2 to make new text chat with properties {service:imService, participants:{theRecipient}}
               send theText to fallbackChat2
               return "OK"
             on error errMsg3 number errNum3
               error "Send failed via SMS and iMessage. Details: " & errMsg3
             end try
           else
             error "Send failed: " & errMsg
           end if
         else
           -- Unknown handle; just surface original error
           error "Send failed: " & errMsg
         end if
       end try
     end timeout
   end tell
 end run`;

  await runAppleScriptInline(script, [recipient, text]);
}
