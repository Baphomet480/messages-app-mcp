use framework "Foundation"
use scripting additions

on run argv
  if (count of argv) < 2 then error "Recipient handle and payload path required."
  set targetHandle to item 1 of argv
  set payloadPath to item 2 of argv

  set messageText to my readUtf8File(payloadPath)
  if messageText is missing value or messageText is "" then error "Message text must not be empty."

  return my sendWithFallback(targetHandle, messageText)
end run

on readUtf8File(posixPath)
  set fileURL to current application's NSURL's fileURLWithPath:posixPath
  set {textValue, readError} to current application's NSString's stringWithContentsOfURL:fileURL encoding:(current application's NSUTF8StringEncoding) |error|:(reference)
  if textValue is missing value then
    if readError is missing value then error "Unable to read payload."
    error (readError's localizedDescription() as string)
  end if
  return textValue as string
end readUtf8File

on sendWithFallback(handleValue, bodyText)
  set normalizedHandle to my trimText(handleValue)
  if normalizedHandle is "" then error "Recipient handle missing."
  set sanitizedBody to my coerceUnicode(bodyText)

  set imessageResult to my sendViaService(normalizedHandle, sanitizedBody, "iMessage", "imessage")
  if (item 1 of imessageResult) is true then return "imessage"
  set smsResult to my sendViaService(normalizedHandle, sanitizedBody, "SMS", "sms")
  if (item 1 of smsResult) is true then return "sms"

  set imessageError to item 3 of imessageResult
  set smsError to item 3 of smsResult
  set combinedError to ""
  if imessageError is not "" then set combinedError to imessageError
  if combinedError is "" and smsError is not "" then set combinedError to smsError
  if combinedError is "" then set combinedError to "Unable to deliver via iMessage or SMS."
  error combinedError
end sendWithFallback

on sendViaService(handleValue, bodyText, serviceType, routeName)
  tell application "Messages"
    set serviceRef to my findService(serviceType)
    if serviceRef is missing value then return {false, routeName, "Service " & serviceType & " unavailable."}

    set targetRef to my locateHandleWithService(handleValue, serviceRef)
    if targetRef is missing value then
      try
        set targetRef to make new text chat with properties {service:serviceRef, participants:{handleValue}}
        delay 0.1
      end try
    end if
    if targetRef is missing value then return {false, routeName, "Unable to resolve " & handleValue & " for " & serviceType & "."}

    try
      send bodyText to targetRef
      return {true, routeName, ""}
    on error errMsg number errNum
      return {false, routeName, (errMsg as string)}
    end try
  end tell
end sendViaService

on findService(serviceType)
  tell application "Messages"
    try
      return first service whose service type is serviceType
    on error
      return missing value
    end try
  end tell
end findService

on locateHandleWithService(handleValue, serviceRef)
  tell application "Messages"
    try
      set participantRef to participant id handleValue of serviceRef
      if participantRef is not missing value then return participantRef
    end try
    try
      set buddyRef to buddy id handleValue of serviceRef
      if buddyRef is not missing value then return buddyRef
    end try
    try
      set buddyDirect to buddy handleValue of serviceRef
      if buddyDirect is not missing value then return buddyDirect
    end try
    try
      repeat with existingChat in chats
        if service of existingChat is serviceRef then
          try
            set members to participants of existingChat
            if members contains handleValue then return existingChat
          end try
        end if
      end repeat
    end try
  end tell
  return missing value
end locateHandleWithService

on trimText(value)
  set nsStr to current application's NSString's stringWithString:(value as string)
  set whitespace to current application's NSCharacterSet's whitespaceAndNewlineCharacterSet()
  return (nsStr's stringByTrimmingCharactersInSet:whitespace) as string
end trimText

on coerceUnicode(value)
  try
    return (value as Unicode text)
  on error
    return value as string
  end try
end coerceUnicode
