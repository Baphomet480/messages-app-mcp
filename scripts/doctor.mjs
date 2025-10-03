#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const wantJson = args.includes('--json')

async function main() {
  const modPath = resolve(__dirname, '../dist/utils/doctor.js')
  if (!existsSync(modPath)) {
    console.error('Build required. Run: pnpm run build')
    process.exit(2)
  }
  const { runDoctor } = await import(pathToFileURL(modPath).href)
  if (typeof runDoctor !== 'function') {
    console.error('runDoctor not found in dist. Did the build succeed?')
    process.exit(2)
  }
  try {
    const report = await runDoctor()
    if (wantJson) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(report.summary)
      if (report.notes?.length) {
        console.log('\nnotes:')
        for (const n of report.notes) console.log(`- ${n}`)
      }
    }
    process.exit(report.ok ? 0 : 1)
  } catch (e) {
    console.error('doctor failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

main()
