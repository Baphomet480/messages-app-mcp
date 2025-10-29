"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BufferReader = void 0;
class BufferReader {
    constructor(buffer, initialOffset = 0) {
        this.buffer = buffer;
        this.offset = initialOffset;
    }
    get position() {
        return this.offset;
    }
    get length() {
        return this.buffer.length;
    }
    get remaining() {
        return this.buffer.length - this.offset;
    }
    seek(position) {
        if (position < 0 || position > this.buffer.length) {
            throw new Error(`Invalid seek position: ${position}`);
        }
        this.offset = position;
    }
    skip(bytes) {
        this.offset += bytes;
    }
    readUInt8() {
        const value = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return value;
    }
    readUInt16LE() {
        const value = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
    }
    readUInt16BE() {
        const value = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }
    readUInt32LE() {
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }
    readUInt32BE() {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }
    readBytes(length) {
        if (this.offset + length > this.buffer.length) {
            throw new Error('Attempt to read beyond buffer length');
        }
        const bytes = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return bytes;
    }
    readString(length, encoding = 'utf8') {
        const bytes = this.readBytes(length);
        return bytes.toString(encoding);
    }
    findPattern(pattern) {
        const searchBuffer = typeof pattern === 'string' ? Buffer.from(pattern) : pattern;
        const index = this.buffer.indexOf(searchBuffer, this.offset);
        return index >= 0 ? index : -1;
    }
    readUntil(delimiter) {
        const delimBuffer = typeof delimiter === 'string' ? Buffer.from(delimiter) : delimiter;
        const index = this.findPattern(delimBuffer);
        if (index === -1) {
            return null;
        }
        const result = this.buffer.slice(this.offset, index);
        this.offset = index + delimBuffer.length;
        return result;
    }
    peekByte() {
        if (this.offset >= this.buffer.length) {
            return null;
        }
        return this.buffer[this.offset];
    }
    peekBytes(length) {
        if (this.offset + length > this.buffer.length) {
            return null;
        }
        return this.buffer.slice(this.offset, this.offset + length);
    }
}
exports.BufferReader = BufferReader;
//# sourceMappingURL=buffer-reader.js.map