"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypedStreamParser = void 0;
const buffer_reader_1 = require("../utils/buffer-reader");
/**
 * Parser for Apple's typedstream format used in NSArchiver
 * Based on format analysis and pytypedstream implementation
 */
class TypedStreamParser {
    constructor(buffer) {
        this.reader = new buffer_reader_1.BufferReader(buffer);
    }
    /**
     * Parse the typedstream header
     */
    parseHeader() {
        const startPos = this.reader.position;
        // Look for 'streamtyped' magic
        const magic = this.reader.peekBytes(11);
        if (!magic || magic.toString('ascii') !== 'streamtyped') {
            return false;
        }
        this.reader.skip(11);
        // Skip version bytes and other header data
        // The exact header format varies, but we can skip to content
        while (this.reader.remaining > 0) {
            const byte = this.reader.peekByte();
            if (byte === null)
                break;
            // Look for start of class names
            const next4 = this.reader.peekBytes(4);
            if (next4 && next4.toString('ascii').match(/^[A-Z]/)) {
                break;
            }
            this.reader.skip(1);
        }
        this.header = {
            version: 4, // NSArchiver version
            byteOrder: 'big',
        };
        return true;
    }
    /**
     * Parse NSString objects from the stream
     */
    parseNSString() {
        const markerPos = this.reader.findPattern('NSString');
        if (markerPos === -1)
            return null;
        this.reader.seek(markerPos + 8); // Skip 'NSString' (8 characters)
        // Check for preamble
        const preamble = this.reader.peekBytes(5);
        if (preamble && preamble.equals(TypedStreamParser.MAGIC_BYTES.PREAMBLE_NSSTRING)) {
            this.reader.skip(5);
        }
        // Read length
        let length = 0;
        const lengthByte = this.reader.readUInt8();
        if (lengthByte === 0x81) {
            // 3-byte length (little endian)
            length = this.reader.readUInt16LE();
        }
        else {
            // 1-byte length
            length = lengthByte;
        }
        if (length === 0 || length > this.reader.remaining) {
            return null;
        }
        // Read string content
        const content = this.reader.readString(length, 'utf8');
        return {
            className: 'NSString',
            content: content,
            encoding: 'utf8',
        };
    }
    /**
     * Parse all NSString objects in the buffer
     */
    parseAllNSStrings() {
        const strings = [];
        // Parse header if present
        this.parseHeader();
        // Reset to start if no header found
        if (!this.header) {
            this.reader.seek(0);
        }
        while (this.reader.remaining > 0) {
            const string = this.parseNSString();
            if (string) {
                strings.push(string);
            }
            else {
                // If no string found, advance by 1 byte to continue searching
                if (this.reader.remaining > 0) {
                    this.reader.skip(1);
                }
            }
        }
        return strings;
    }
    /**
     * Extract readable text segments from the buffer
     * This is a fallback method when proper parsing fails
     */
    extractReadableText() {
        this.reader.seek(0);
        const texts = [];
        let currentText = '';
        let inText = false;
        while (this.reader.remaining > 0) {
            const byte = this.reader.readUInt8();
            // Check if byte is printable ASCII or valid UTF-8
            if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
                currentText += String.fromCharCode(byte);
                inText = true;
            }
            else if (byte >= 128 && byte <= 255) {
                // Potential UTF-8 continuation
                if (this.isValidUTF8Sequence(byte)) {
                    currentText += this.readUTF8Char(byte);
                    inText = true;
                }
                else {
                    // End of text segment
                    if (inText && currentText.length > 3) {
                        const cleaned = this.cleanText(currentText);
                        if (cleaned.length > 3) {
                            texts.push(cleaned);
                        }
                    }
                    currentText = '';
                    inText = false;
                }
            }
            else {
                // Non-text byte
                if (inText && currentText.length > 3) {
                    const cleaned = this.cleanText(currentText);
                    if (cleaned.length > 3) {
                        texts.push(cleaned);
                    }
                }
                currentText = '';
                inText = false;
            }
        }
        // Don't forget the last segment
        if (currentText.length > 3) {
            const cleaned = this.cleanText(currentText);
            if (cleaned.length > 3) {
                texts.push(cleaned);
            }
        }
        return texts;
    }
    isValidUTF8Sequence(firstByte) {
        this.reader.seek(this.reader.position - 1); // Back up one byte
        if ((firstByte & 0xE0) === 0xC0) {
            // 2-byte sequence
            return this.reader.remaining >= 2;
        }
        else if ((firstByte & 0xF0) === 0xE0) {
            // 3-byte sequence
            return this.reader.remaining >= 3;
        }
        else if ((firstByte & 0xF8) === 0xF0) {
            // 4-byte sequence
            return this.reader.remaining >= 4;
        }
        this.reader.skip(1); // Move forward again
        return false;
    }
    readUTF8Char(firstByte) {
        const bytes = [firstByte];
        if ((firstByte & 0xE0) === 0xC0) {
            // 2-byte sequence
            bytes.push(this.reader.readUInt8());
        }
        else if ((firstByte & 0xF0) === 0xE0) {
            // 3-byte sequence
            bytes.push(this.reader.readUInt8());
            bytes.push(this.reader.readUInt8());
        }
        else if ((firstByte & 0xF8) === 0xF0) {
            // 4-byte sequence
            bytes.push(this.reader.readUInt8());
            bytes.push(this.reader.readUInt8());
            bytes.push(this.reader.readUInt8());
        }
        try {
            return Buffer.from(bytes).toString('utf8');
        }
        catch {
            return '';
        }
    }
    cleanText(text) {
        // Remove common metadata strings
        const metadata = [
            'streamtyped', 'NSMutableAttributedString', 'NSAttributedString',
            'NSObject', 'NSMutableString', 'NSString', 'NSDictionary',
            'NSNumber', 'NSValue', 'NSFont', 'NSParagraphStyle',
            '__kIM', 'NSData', 'bplist', 'NSKeyedArchiver',
            'NS.rangeval', 'Z$classname', '$class', '$classname'
        ];
        let cleaned = text;
        metadata.forEach(meta => {
            cleaned = cleaned.replace(new RegExp(meta, 'g'), '');
        });
        // Remove other artifacts
        cleaned = cleaned.replace(/\{[^}]*\}/g, ''); // Remove {} blocks
        cleaned = cleaned.replace(/\[[^\]]*\]/g, ''); // Remove [] blocks  
        cleaned = cleaned.replace(/\x00-\x1F/g, ''); // Remove control chars
        cleaned = cleaned.replace(/\s+/g, ' '); // Normalize whitespace
        return cleaned.trim();
    }
}
exports.TypedStreamParser = TypedStreamParser;
// Known class markers in typedstream format
TypedStreamParser.CLASS_MARKERS = {
    NS_STRING: 'NSString',
    NS_MUTABLE_STRING: 'NSMutableString',
    NS_ATTRIBUTED_STRING: 'NSAttributedString',
    NS_MUTABLE_ATTRIBUTED_STRING: 'NSMutableAttributedString',
    NS_DICTIONARY: 'NSDictionary',
    NS_ARRAY: 'NSArray',
    NS_NUMBER: 'NSNumber',
    NS_DATA: 'NSData',
};
// Magic bytes for typedstream format
TypedStreamParser.MAGIC_BYTES = {
    STREAM_TYPEDSTREAM: Buffer.from('streamtyped'),
    PREAMBLE_NSSTRING: Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
};
//# sourceMappingURL=typedstream-parser.js.map