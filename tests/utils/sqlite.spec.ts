import { describe, expect, it } from 'vitest'
import { appleEpochToUnixMs, resolveAttachmentPath } from '../../src/utils/sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Apple epoch starts 2001-01-01T00:00:00Z => UNIX 978307200 seconds
const APPLE_EPOCH_UNIX = 978307200 * 1000

describe('appleEpochToUnixMs', () => {
  it('handles seconds', () => {
    expect(appleEpochToUnixMs(0)).toBe(APPLE_EPOCH_UNIX)
    expect(appleEpochToUnixMs(1)).toBe(APPLE_EPOCH_UNIX + 1000)
  })

  it('handles microseconds (large realistic value)', () => {
    // 1,500,000 seconds in microseconds (≈17.36 days)
    const us = 1_500_000_000_000
    expect(appleEpochToUnixMs(us)).toBe(APPLE_EPOCH_UNIX + 1_500_000_000)
  })

  it('handles nanoseconds (large realistic value)', () => {
    // 2,000,000 seconds in nanoseconds (≈23.1 days)
    const ns = 2_000_000_000_000_000
    expect(appleEpochToUnixMs(ns)).toBe(APPLE_EPOCH_UNIX + 2_000_000_000)
  })

  it('handles milliseconds (heuristic)', () => {
    // Heuristic branch when n > 1e9: treat as milliseconds
    const ms = 2_500_000_000 // 2,500,000 seconds
    expect(appleEpochToUnixMs(ms)).toBe(APPLE_EPOCH_UNIX + 2_500_000_000)
  })

  it('handles null/undefined and non-finite', () => {
    expect(appleEpochToUnixMs(null as unknown as number)).toBeNull()
    expect(appleEpochToUnixMs(undefined as unknown as number)).toBeNull()
    expect(appleEpochToUnixMs(Number.NaN)).toBeNull()
  })
})

describe('resolveAttachmentPath', () => {
  it('expands leading ~/', () => {
    const home = homedir()
    expect(resolveAttachmentPath('~/Library/Messages/foo.jpg')).toBe(join(home, 'Library/Messages/foo.jpg'))
  })

  it('preserves absolute paths', () => {
    const path = '/Users/example/Library/foo.mov'
    expect(resolveAttachmentPath(path)).toBe(path)
  })

  it('treats bare ~ as home directory', () => {
    const home = homedir()
    expect(resolveAttachmentPath('~')).toBe(home)
  })

  it('assumes relative paths are under home', () => {
    const home = homedir()
    expect(resolveAttachmentPath('Library/Messages/Attachments/abc')).toBe(join(home, 'Library/Messages/Attachments/abc'))
  })
})
