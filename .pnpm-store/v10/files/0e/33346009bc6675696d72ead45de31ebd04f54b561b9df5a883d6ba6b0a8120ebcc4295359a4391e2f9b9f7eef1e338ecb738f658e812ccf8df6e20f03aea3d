# node-imessage-parser

A Node.js library for parsing iMessage `chat.db` database files, specifically handling the `attributedBody` field that contains NSAttributedString data in Apple's proprietary typedstream format.

## Features

- Parse iMessage `attributedBody` fields containing formatted text
- Extract plain text from NSAttributedString binary data
- Handle multi-line messages with proper formatting preservation
- Support for numbered lists and sub-items
- Fallback text extraction for corrupted or unknown formats
- Direct database access with search capabilities
- Build deep links to iMessage conversations and messages

## Installation

```bash
npm install imessage-parser

# Or install globally for CLI access
npm install -g imessage-parser
```

## CLI Usage

The package includes a comprehensive CLI for working with iMessage data:

```bash
# List all chats
imessage-parser list-chats

# Extract messages from a specific chat
imessage-parser extract "Family Chat" -o family-messages.md -f markdown

# Search for messages across all chats
imessage-parser search "vacation plans" --limit 20

# Parse a specific message by ROWID
imessage-parser parse-message 302041 --show-readable

# Show statistics
imessage-parser stats -c "Family Chat"

# Get help
imessage-parser --help
```

### CLI Commands

- **list-chats** - List all available chats with their IDs
- **extract** - Extract messages from a specific chat
  - Supports text, JSON, and Markdown output formats
  - Can filter by date range
  - Optionally includes formatting information
- **search** - Search messages across all chats
  - Supports case-sensitive and regex search
  - Highlights search terms in results
- **parse-message** - Parse and analyze a specific message
  - Shows hex dump of attributedBody
  - Displays all readable text segments
  - Extracts formatting attributes
- **stats** - Display statistics about messages
  - Overall database stats or per-chat statistics
  - Message counts, date ranges, and formatting info

## Programmatic Usage

### Basic Usage

```javascript
const { parseAttributedBody } = require('imessage-parser');

// Parse a Buffer containing attributedBody data
const buffer = /* Buffer from iMessage database */;
const result = parseAttributedBody(buffer);

console.log(result.text); // Extracted message text
```

### Database Access

```javascript
const { IMessageDatabase } = require('imessage-parser');

async function readMessages() {
  // Connect to the iMessage database
  const db = new IMessageDatabase(); // Uses default path: ~/Library/Messages/chat.db

  try {
    // Get all chats
    const chats = await db.getChats();
    console.log(`Found ${chats.length} chats`);

    // Get messages from a specific chat
    const messages = await db.getMessagesFromChat(chats[0].ROWID, 50);
    
    for (const message of messages) {
      const parsed = db.parseMessage(message);
      console.log(`${message.is_from_me ? 'Me' : 'Them'}: ${parsed.text}`);
    }

    // Search for messages containing specific text
    const results = await db.searchMessages('currency');
    console.log(`Found ${results.length} messages containing "currency"`);

  } finally {
    await db.close();
  }
}
```

### Advanced Parser Options

```javascript
const { AttributedStringParser } = require('imessage-parser');

const parser = new AttributedStringParser({
  preserveFormatting: true,  // Preserve line breaks and formatting
  includeMetadata: true,     // Include attributes and raw data
  cleanOutput: true,         // Clean up whitespace and artifacts
  encoding: 'utf8'           // Text encoding
});

const result = parser.parse(attributedBodyBuffer);
console.log(result.text);       // Parsed text
console.log(result.attributes); // Message attributes (if any)
console.log(result.rawData);    // Original buffer
```

### Extract Messages with Formatting

```javascript
const { IMessageDatabase } = require('imessage-parser');

async function extractFormattedMessages() {
  const db = new IMessageDatabase();

  try {
    // Get messages from the last week
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const endDate = new Date();

    const messages = await db.getAttributedMessagesInRange(
      startDate, 
      endDate,
      'Family Chat' // Optional: filter by chat name
    );

    for (const message of messages) {
      const parsed = db.parseMessage(message);
      
      if (parsed.text.includes('?')) {
        console.log('\nQuestion found:');
        console.log(parsed.text);
        console.log('---');
      }
    }
  } finally {
    await db.close();
  }
}
```

## API Reference

### `parseAttributedBody(buffer, options?)`

Convenience function to parse a single attributedBody buffer.

- `buffer` - Buffer containing NSAttributedString data
- `options` - Optional parser options
- Returns: `ParsedMessage` object with extracted text

### `IMessageDatabase`

Main class for accessing the iMessage database.

#### Methods:
- `constructor(dbPath?, parserOptions?)` - Create new database instance
- `getChats()` - Get all chat conversations
- `getMessagesFromChat(chatId, limit?, offset?)` - Get messages from a specific chat
- `parseMessage(message)` - Parse a message row to extract text
- `searchMessages(searchTerm, limit?)` - Search messages by content
- `getAttributedMessagesInRange(startDate, endDate, chatName?)` - Get messages with attributedBody in date range
- `close()` - Close database connection

### `AttributedStringParser`

Core parser for NSAttributedString format.

#### Methods:
- `constructor(options?)` - Create new parser instance
- `parse(buffer)` - Parse attributedBody buffer

#### Options:
- `preserveFormatting` - Preserve line breaks and formatting (default: true)
- `includeMetadata` - Include attributes and raw data in result (default: false)
- `cleanOutput` - Clean up whitespace and artifacts (default: true)
- `encoding` - Text encoding (default: 'utf8')

## Formatting Extraction

The parser can extract various formatting attributes from messages:

### Supported Formatting

- **Text Styles**: Bold, italic, underline, strikethrough
- **Links**: URLs with their display text and position
- **Mentions**: @mentions with phone numbers or emails
- **Data Detectors**: Dates, times, addresses, phone numbers, flights, measurements
- **Fonts**: Font family, size, weight, and style
- **Colors**: Text and background colors with RGB values
- **Attachments**: Attachment indicators and metadata

### Example: Extract All Formatting

```javascript
const { IMessageDatabase } = require('imessage-parser');

const db = new IMessageDatabase(undefined, { includeMetadata: true });
const messages = await db.getMessagesFromChat(chatId);

messages.forEach(msg => {
  const parsed = db.parseMessage(msg);
  
  if (parsed.attributes?.links) {
    parsed.attributes.links.forEach(link => {
      console.log(`Link: ${link.url} at position ${link.location}`);
    });
  }
  
  if (parsed.attributes?.bold) {
    parsed.attributes.bold.forEach(range => {
      const boldText = parsed.text.substring(range.location, range.location + range.length);
      console.log(`Bold text: "${boldText}"`);
    });
  }
  
  if (parsed.attributes?.dataDetectors) {
    parsed.attributes.dataDetectors.forEach(detector => {
      console.log(`Detected ${detector.type}: ${detector.value}`);
    });
  }
});
```

## How It Works

iMessage stores formatted messages in the `attributedBody` field using Apple's NSAttributedString format, serialized with NSArchiver (typedstream format). This library:

1. Identifies NSString objects within the binary data
2. Extracts text content following the typedstream format specification
3. Parses NSDictionary structures containing formatting attributes
4. Reconstructs the original message with proper formatting
5. Falls back to readable text extraction for unknown formats

The typedstream format for NSString typically follows this pattern:
```
| "NSString" | preamble (5 bytes) | length | content |
```

Where:
- Preamble is usually `0x01 0x94 0x84 0x01 0x2b`
- Length is either 1 byte or 3 bytes (if first byte is `0x81`)
- Content is UTF-8 encoded text

Formatting attributes are stored in NSDictionary structures with range information indicating where the formatting applies in the text.

## Requirements

- Node.js 14 or higher
- macOS (for accessing iMessage database)
- Read access to `~/Library/Messages/chat.db`

### Building iMessage Deep Links

The library can automatically generate deep links to open specific messages or conversations in the Messages app.

```javascript
const { IMessageDatabase } = require('imessage-parser');

const db = new IMessageDatabase();

// Parse message - link is always included
const messages = await db.getMessagesFromChat(chatId, 1);
const parsed = db.parseMessage(messages[0]);
console.log(parsed);
// {
//   text: "Hello world",
//   link: "messages://open?guid=12345-67890-ABCDEF"
// }

// Get messages with full chat context for better links
const messagesWithChat = await db.getMessagesWithChatInfo(chatId);
const parsedWithChat = db.parseMessageWithChat(messagesWithChat[0]);
console.log(parsedWithChat.link);
// Automatically selects best link type:
// - "messages://open?guid=<message-guid>" (specific message)
// - "sms://+15551234567" (conversation fallback)
// - "messages://open?guid=<chat-guid>" (group chat fallback)
```

For more control over link generation:

```javascript
const { buildChatLinks, buildMessageLink, buildComposeLink } = require('imessage-parser');

// Get all possible links for a chat
const chatLinks = buildChatLinks(chat);

// Build link for specific message
const messageLink = buildMessageLink(message);

// Build compose link with pre-filled text
const composeLink = buildComposeLink('+15551234567', 'Hello!');
```

#### URL Scheme Support

- **`sms://`** - Opens conversations (universally supported)
- **`imessage://`** - Alternative for opening conversations
- **`messages://`** - Opens specific messages (requires special entitlements in some contexts)

📖 **[See the Deep Linking Guide](docs/deep-linking.md)** for comprehensive documentation on URL schemes, special entitlements, platform compatibility, and troubleshooting.

## Privacy & Security

When using this library, please be mindful of privacy:

- The iMessage database contains personal conversations
- Always obtain consent before accessing or processing someone else's messages
- Be careful not to commit message data to version control
- Consider anonymizing data when sharing examples or debugging

## Limitations

- Only works on macOS with local iMessage database
- Cannot decrypt messages if database is encrypted
- Some complex formatting may not be fully preserved
- Attributes (bold, italic, links) extraction is not yet implemented
- Deep links to specific messages may not work in all contexts

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT