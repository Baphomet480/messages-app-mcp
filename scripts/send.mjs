#!/usr/bin/env node
// Simple CLI sender: npm run send -- "+1XXXXXXXXXX" "Your message"
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function maskRecipient(recipient) {
  if (!recipient) return ''
  if (recipient.includes('@')) {
    const [local, domain] = recipient.split('@')
    if (!domain) return '***'
    const first = local.slice(0, 1) || '*'
    return `${first}***@${domain}`
  }
  const digitsOnly = recipient.replace(/\D/g, '')
  if (digitsOnly.length <= 4) return recipient
  let seen = 0
  let result = ''
  for (const ch of recipient) {
    if (/\d/.test(ch)) {
      const remaining = digitsOnly.length - seen
      result += remaining > 4 ? '•' : ch
      seen++
    } else {
      result += ch
    }
  }
  return result
}

function cleanOsaError(err) {
  const raw = err instanceof Error ? err.message : String(err)
  let m = String(raw)
  m = m.replace(/^osascript failed:\s*/i, '')
  m = m.replace(/execution error:\s*/i, '')
  m = m.replace(/messages? got an error:\s*/i, '')
  m = m.replace(/\s*\([\-\d]+\)\s*$/i, '')
  m = m.replace(/^"|"$/g, '')
  return m.trim()
}

async function main() {
  const args = process.argv.slice(2)
  // Default: reveal full recipient. Use --mask/-m to mask locally.
  let mask = false
  if (args[0] === '--mask' || args[0] === '-m') {
    mask = true
    args.shift()
  }
  const recipient = args[0]
  const rest = args.slice(1)
  if (!recipient || rest.length === 0) {
    console.error('Usage: npm run send -- [--reveal|-r] <recipient> "message text"')
    process.exit(2)
  }
  const text = rest.join(' ')

  const distPath = resolve(__dirname, '../dist/utils/applescript.js')
  if (!existsSync(distPath)) {
    console.error('Build required. Run: npm run build')
    process.exit(2)
  }

  const mod = await import(pathToFileURL(distPath).href)
  const { sendMessageAppleScript } = mod
  if (typeof sendMessageAppleScript !== 'function') {
    console.error('sendMessageAppleScript not found in dist. Did the build succeed?')
    process.exit(2)
  }

  try {
    await sendMessageAppleScript(recipient, text)
    console.log(`Sent to ${mask ? maskRecipient(recipient) : recipient}.`)
  } catch (e) {
    console.error(`Failed to send to ${mask ? maskRecipient(recipient) : recipient}. ${cleanOsaError(e)}`)
    process.exit(1)
  }
}

main()
