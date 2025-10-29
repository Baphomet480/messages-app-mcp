"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NSDictionaryParser = void 0;
const buffer_reader_1 = require("../utils/buffer-reader");
/**
 * Parser for NSDictionary structures in typedstream format
 * These contain formatting attributes in iMessage
 */
class NSDictionaryParser {
    constructor(buffer, offset = 0) {
        this.reader = new buffer_reader_1.BufferReader(buffer, offset);
    }
    /**
     * Parse NSDictionary structure
     */
    parse() {
        const dict = new Map();
        // Look for NSDictionary marker
        const dictMarker = this.reader.findPattern('NSDictionary');
        if (dictMarker === -1)
            return null;
        this.reader.seek(dictMarker + 12); // Skip 'NSDictionary'
        // Common attribute keys in iMessage
        const attributeKeys = [
            '__kIMMessagePartAttributeName',
            '__kIMFileTransferGUIDAttributeName',
            '__kIMMentionedHandleAttributeName',
            '__kIMDataDetectedAttributeName',
            '__kIMCalendarEventAttributeName',
            'NSFont',
            'NSColor',
            'NSParagraphStyle',
            'NSLink',
            'NSUnderline',
            'NSStrikethrough',
            'NSBackgroundColor',
            'NSAttachment'
        ];
        // Try to find and parse known attributes
        for (const key of attributeKeys) {
            const keyPos = this.reader.findPattern(key);
            if (keyPos !== -1) {
                this.reader.seek(keyPos + key.length);
                // Try to parse the value based on the key
                const value = this.parseAttributeValue(key);
                if (value !== null) {
                    dict.set(key, value);
                }
            }
        }
        // Parse font attributes
        this.parseFontAttributes(dict);
        // Parse range attributes
        this.parseRangeAttributes(dict);
        return dict.size > 0 ? dict : null;
    }
    /**
     * Parse attribute value based on key type
     */
    parseAttributeValue(key) {
        switch (key) {
            case 'NSFont':
                return this.parseFontValue();
            case 'NSColor':
                return this.parseColorValue();
            case 'NSLink':
                return this.parseLinkValue();
            case '__kIMMentionedHandleAttributeName':
                return this.parseMentionValue();
            case '__kIMDataDetectedAttributeName':
                return this.parseDataDetectedValue();
            default:
                return this.parseGenericValue();
        }
    }
    /**
     * Parse font information
     */
    parseFontValue() {
        const fontInfo = {};
        // Look for font name
        const helveticaPos = this.reader.findPattern('Helvetica');
        if (helveticaPos !== -1) {
            fontInfo.family = 'Helvetica';
        }
        // Look for font size (usually follows font name)
        const sizeMarkers = [12, 13, 14, 16, 17, 18, 24, 36];
        for (const size of sizeMarkers) {
            const sizeBytes = Buffer.from([size, 0, 0, 0]);
            if (this.reader.findPattern(sizeBytes) !== -1) {
                fontInfo.size = size;
                break;
            }
        }
        return Object.keys(fontInfo).length > 0 ? fontInfo : null;
    }
    /**
     * Parse color information
     */
    parseColorValue() {
        // Colors are often stored as RGB or RGBA values
        // Look for common patterns
        const colorPatterns = [
            { pattern: Buffer.from([0, 0, 0, 255]), color: 'black' },
            { pattern: Buffer.from([255, 255, 255, 255]), color: 'white' },
            { pattern: Buffer.from([255, 0, 0, 255]), color: 'red' },
            { pattern: Buffer.from([0, 255, 0, 255]), color: 'green' },
            { pattern: Buffer.from([0, 0, 255, 255]), color: 'blue' },
        ];
        for (const { pattern, color } of colorPatterns) {
            if (this.reader.findPattern(pattern) !== -1) {
                return { color, rgba: Array.from(pattern) };
            }
        }
        return null;
    }
    /**
     * Parse link URL
     */
    parseLinkValue() {
        // Links often appear as strings after NSLink
        const httpPos = this.reader.findPattern('http');
        if (httpPos !== -1) {
            this.reader.seek(httpPos);
            // Read until we hit a non-URL character
            let url = '';
            while (this.reader.remaining > 0) {
                const byte = this.reader.peekByte();
                if (byte === null)
                    break;
                const char = String.fromCharCode(byte);
                if (/[a-zA-Z0-9:\/\.\-_\?=&%]/.test(char)) {
                    url += char;
                    this.reader.skip(1);
                }
                else {
                    break;
                }
            }
            return url.length > 10 ? url : null;
        }
        return null;
    }
    /**
     * Parse mention (@ handle)
     */
    parseMentionValue() {
        // Look for phone number or email patterns
        const phonePattern = /\+?1?\d{10,}/;
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const text = this.reader.readString(100, 'utf8');
        const phoneMatch = text.match(phonePattern);
        if (phoneMatch)
            return phoneMatch[0];
        const emailMatch = text.match(emailPattern);
        if (emailMatch)
            return emailMatch[0];
        return null;
    }
    /**
     * Parse data detected items (dates, addresses, etc.)
     */
    parseDataDetectedValue() {
        const result = {};
        // Look for common data detector results
        const patterns = [
            { marker: 'DDScannerResult', type: 'scanner_result' },
            { marker: 'Date', type: 'date' },
            { marker: 'Time', type: 'time' },
            { marker: 'PhysicalAmount', type: 'measurement' },
            { marker: 'FlightInformation', type: 'flight' },
        ];
        for (const { marker, type } of patterns) {
            if (this.reader.findPattern(marker) !== -1) {
                result.type = type;
                result.marker = marker;
                // Try to extract associated data
                if (type === 'date' || type === 'time') {
                    result.value = this.extractDateTimeValue();
                }
                break;
            }
        }
        return Object.keys(result).length > 0 ? result : null;
    }
    /**
     * Extract date/time value
     */
    extractDateTimeValue() {
        // Look for common date/time patterns
        const patterns = [
            'tomorrow',
            'today',
            'yesterday',
            /\d{1,2}:\d{2}/,
            /\d{1,2}\/\d{1,2}\/\d{2,4}/,
        ];
        const text = this.reader.readString(50, 'utf8');
        for (const pattern of patterns) {
            if (typeof pattern === 'string') {
                if (text.includes(pattern))
                    return pattern;
            }
            else {
                const match = text.match(pattern);
                if (match)
                    return match[0];
            }
        }
        return null;
    }
    /**
     * Parse generic value
     */
    parseGenericValue() {
        // Try to read as string
        const bytes = this.reader.peekBytes(100);
        if (!bytes)
            return null;
        // Look for readable text
        let text = '';
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            if (byte >= 32 && byte <= 126) {
                text += String.fromCharCode(byte);
            }
            else if (text.length > 3) {
                break;
            }
        }
        return text.length > 3 ? text.trim() : null;
    }
    /**
     * Parse font formatting attributes
     */
    parseFontAttributes(dict) {
        // Look for bold/italic indicators
        const boldMarkers = ['Bold', '-Bold', 'Semibold', 'Heavy'];
        const italicMarkers = ['Italic', 'Oblique', '-Italic'];
        for (const marker of boldMarkers) {
            if (this.reader.findPattern(marker) !== -1) {
                dict.set('bold', true);
                break;
            }
        }
        for (const marker of italicMarkers) {
            if (this.reader.findPattern(marker) !== -1) {
                dict.set('italic', true);
                break;
            }
        }
    }
    /**
     * Parse range attributes (location and length for formatting)
     */
    parseRangeAttributes(dict) {
        // Look for NS.rangeval patterns
        const rangePattern = 'NS.rangeval';
        let rangePos = this.reader.findPattern(rangePattern);
        const ranges = [];
        while (rangePos !== -1) {
            this.reader.seek(rangePos + rangePattern.length);
            // Skip to numeric values
            this.reader.skip(10); // Skip some bytes
            // Try to read two integers (location and length)
            if (this.reader.remaining >= 8) {
                const location = this.reader.readUInt32LE();
                const length = this.reader.readUInt32LE();
                if (location < 10000 && length < 1000 && length > 0) {
                    ranges.push({ location, length });
                }
            }
            // Look for next range
            rangePos = this.reader.findPattern(rangePattern);
        }
        if (ranges.length > 0) {
            dict.set('ranges', ranges);
        }
    }
}
exports.NSDictionaryParser = NSDictionaryParser;
//# sourceMappingURL=nsdictionary-parser.js.map