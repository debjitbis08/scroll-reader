import chokidar from 'chokidar'
import { processDocument } from './pipeline.ts'

const SUPPORTED = /\.(epub|pdf|txt)$/i

/**
 * Watches `watchDir` for new EPUB, PDF, and TXT files and runs them
 * through the processing pipeline. Existing files in the directory are
 * picked up immediately on startup (ignoreInitial: false).
 *
 * @param watchDir  Directory to watch (WATCH_DIR env var)
 * @param userId    Profile ID to associate all ingested documents with
 */
export function startWatcher(watchDir: string, userId: string): void {
  console.log(`[watcher] Watching ${watchDir} for new documents`)

  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: false,
    // Wait for the file to stop changing before processing (avoids partial reads)
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  })

  watcher.on('add', (filePath) => {
    if (!SUPPORTED.test(filePath)) return
    processDocument(filePath, userId).catch((err) => {
      console.error(`[watcher] Unhandled error for ${filePath}:`, err)
    })
  })

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err)
  })
}
