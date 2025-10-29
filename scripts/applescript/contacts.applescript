use framework "Foundation"
use scripting additions

on run argv
  if (count of argv) < 1 then error "Contacts command required."
  set command to item 1 of argv
  if command is "lookup" then
    if (count of argv) < 2 then error "Lookup requires a handle."
    set targetHandle to item 2 of argv
    return my lookupContactName(targetHandle)
  else if command is "search" then
    set queryText to ""
    if (count of argv) ≥ 2 then set queryText to item 2 of argv
    set limitCount to 20
    if (count of argv) ≥ 3 then
      try
        set limitCount to item 3 of argv as integer
      end try
    end if
    return my searchContacts(queryText, limitCount)
  else
    error "Unknown contacts command: " & command
  end if
end run

on lookupContactName(targetHandle)
  set normalized to my trimText(targetHandle)
  if normalized is "" then return ""
  tell application "Contacts"
    set peopleByPhone to (people whose value of phones contains normalized)
    if (count of peopleByPhone) > 0 then
      set personRecord to item 1 of peopleByPhone
      set foundName to my safeText(name of personRecord)
      if foundName is not "" then return foundName
    end if
    set peopleByEmail to (people whose value of emails contains normalized)
    if (count of peopleByEmail) > 0 then
      set personRecord to item 1 of peopleByEmail
      set foundName to my safeText(name of personRecord)
      if foundName is not "" then return foundName
    end if
  end tell
  return ""
end lookupContactName

on searchContacts(queryText, limitCount)
  set normalizedQuery to my lowerText(queryText)
  if limitCount < 1 then set limitCount to 1
  if limitCount > 100 then set limitCount to 100

  set resultsArray to current application's NSMutableArray's array()
  set collected to 0

  tell application "Contacts"
    repeat with personRecord in people
      set personName to my safeText(name of personRecord)
      set phonesList to my collectValues(phones of personRecord)
      set emailsList to my collectValues(emails of personRecord)

      set includeRecord to false
      if normalizedQuery is "" then
        set includeRecord to true
      else
        set lowerName to my lowerText(personName)
        if lowerName contains normalizedQuery then
          set includeRecord to true
        else if my anyValueMatches(phonesList, normalizedQuery) then
          set includeRecord to true
        else if my anyValueMatches(emailsList, normalizedQuery) then
          set includeRecord to true
        end if
      end if

      if includeRecord then
        set entryDict to current application's NSMutableDictionary's dictionary()
        entryDict's setObject:personName forKey:"name"
        entryDict's setObject:(my arrayFromList(phonesList)) forKey:"phones"
        entryDict's setObject:(my arrayFromList(emailsList)) forKey:"emails"
        resultsArray's addObject:entryDict
        set collected to collected + 1
        if collected ≥ limitCount then exit repeat
      end if
    end repeat
  end tell

  return my encodeJson(resultsArray)
end searchContacts

on collectValues(fieldList)
  set valuesList to {}
  repeat with fieldRecord in fieldList
    try
      set fieldValue to value of fieldRecord as string
      if fieldValue is not missing value and fieldValue is not "" then
        set end of valuesList to (fieldValue as string)
      end if
    end try
  end repeat
  return valuesList
end collectValues

on anyValueMatches(valuesList, queryText)
  repeat with itemValue in valuesList
    set lowerValue to my lowerText(itemValue)
    if lowerValue contains queryText then return true
    set digitsOnly to my digitsOnly(itemValue)
    if digitsOnly is not "" and queryText is not "" then
      if digitsOnly contains (my digitsOnly(queryText)) then return true
    end if
  end repeat
  return false
end anyValueMatches

on encodeJson(arrayObject)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:arrayObject options:0 |error|:(missing value)
  if jsonData is missing value then error "Unable to encode contact search payload."
  set jsonString to current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)
  return jsonString as string
end encodeJson

on arrayFromList(valuesList)
  set resultArray to current application's NSMutableArray's array()
  repeat with v in valuesList
    resultArray's addObject:(v as string)
  end repeat
  return resultArray
end arrayFromList

on safeText(possibleValue)
  try
    if possibleValue is missing value then return ""
    return possibleValue as text
  on error
    return ""
  end try
end safeText

on lowerText(possibleValue)
  try
    if possibleValue is missing value then return ""
    return (possibleValue as text)'s lowercaseString()
  on error
    return ""
  end try
end lowerText

on trimText(possibleValue)
  try
    set nsStr to current application's NSString's stringWithString:(possibleValue as string)
    set whitespaceSet to current application's NSCharacterSet's whitespaceAndNewlineCharacterSet()
    return (nsStr's stringByTrimmingCharactersInSet:whitespaceSet) as string
  on error
    return ""
  end try
end trimText

on digitsOnly(possibleValue)
  try
    set nsStr to current application's NSString's stringWithString:(possibleValue as string)
    set digitSet to current application's NSCharacterSet's decimalDigitCharacterSet()
    set comps to nsStr's componentsSeparatedByCharactersInSet:(digitSet's invertedSet())
    return (comps's componentsJoinedByString:"") as string
  on error
    return ""
  end try
end digitsOnly
