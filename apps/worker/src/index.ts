import { startWatcher } from './watcher.ts'

const watchDir = process.env.WATCH_DIR
if (!watchDir) {
  console.error('[worker] WATCH_DIR is not set')
  process.exit(1)
}

const userId = process.env.WORKER_USER_ID
if (!userId) {
  console.error('[worker] WORKER_USER_ID is not set (set this to the profile UUID to ingest documents for)')
  process.exit(1)
}

console.log(`[worker] Starting — provider: ${process.env.AI_PROVIDER ?? 'gemini'}`)
startWatcher(watchDir, userId)
