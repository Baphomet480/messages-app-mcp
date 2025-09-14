import { describe, expect, it } from 'vitest'
import { appleEpochToUnixMs } from '../../src/utils/sqlite'

// Apple epoch starts 2001-01-01T00:00:00Z => UNIX 978307200 seconds
const APPLE_EPOCH_UNIX = 978307200 * 1000

describe('appleEpochToUnixMs', () => {
  it('handles seconds', () => {
    expect(appleEpochToUnixMs(0)).toBe(APPLE_EPOCH_UNIX)
    expect(appleEpochToUnixMs(1)).toBe(APPLE_EPOCH_UNIX + 1000)
  })

  it('handles microseconds', () => {
    expect(appleEpochToUnixMs(0)).toBe(APPLE_EPOCH_UNIX)
    const us = 1_500_000 // 1.5s in microseconds
    expect(appleEpochToUnixMs(us)).toBe(APPLE_EPOCH_UNIX + 1500)
  })

  it('handles nanoseconds', () => {
    const ns = 2_000_000_000 // 2s in nanoseconds
    expect(appleEpochToUnixMs(ns)).toBe(APPLE_EPOCH_UNIX + 2000)
  })

  it('handles milliseconds', () => {
    const ms = 2500 // 2.5s in milliseconds
    expect(appleEpochToUnixMs(ms)).toBe(APPLE_EPOCH_UNIX + 2500)
  })

  it('handles null/undefined and non-finite', () => {
    expect(appleEpochToUnixMs(null as unknown as number)).toBeNull()
    expect(appleEpochToUnixMs(undefined as unknown as number)).toBeNull()
    expect(appleEpochToUnixMs(Number.NaN)).toBeNull()
  })
})

