import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import crypto from 'node:crypto'

// ── Machine Identity ──────────────────────────────────────────

const MACHINE_ID_PATH = process.env.FLY_VOLUME_DIR
  ? `${process.env.FLY_VOLUME_DIR}/.machine-id`
  : null

function loadOrCreateMachineId(): string {
  if (MACHINE_ID_PATH) {
    try {
      return readFileSync(MACHINE_ID_PATH, 'utf-8').trim()
    } catch {
      const id = crypto.randomUUID()
      try {
        mkdirSync(dirname(MACHINE_ID_PATH), { recursive: true })
        writeFileSync(MACHINE_ID_PATH, id)
      } catch {
        // Volume not writable — fall through to in-memory ID
      }
      return id
    }
  }
  return crypto.randomUUID()
}

export const MACHINE_ID = loadOrCreateMachineId()

// ── Document Affinity (TTL-based) ─────────────────────────────

const AFFINITY_TTL_MS = 15 * 60 * 1000 // 15 minutes

const affinity = new Map<string, number>()

export function addAffinity(docId: string): void {
  affinity.set(docId, Date.now())
}

export function hasAffinity(docId: string): boolean {
  const ts = affinity.get(docId)
  if (!ts) return false
  if (Date.now() - ts > AFFINITY_TTL_MS) {
    affinity.delete(docId)
    return false
  }
  return true
}

export function cleanAffinity(): void {
  const now = Date.now()
  for (const [docId, ts] of affinity) {
    if (now - ts > AFFINITY_TTL_MS) affinity.delete(docId)
  }
}

// ── Cron Timer ────────────────────────────────────────────────

const CRON_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

let cronRunning = false

/**
 * Returns true if a cron run is already in progress on this machine.
 */
export function isCronRunning(): boolean {
  return cronRunning
}

/**
 * Wraps a cron function with a guard preventing concurrent execution
 * on the same machine. Returns false if skipped due to already running.
 */
export async function runCronGuarded(fn: () => Promise<void>): Promise<boolean> {
  if (cronRunning) {
    console.log(`[cron] skipped — already running on machine=${MACHINE_ID}`)
    return false
  }
  cronRunning = true
  try {
    await fn()
    return true
  } finally {
    cronRunning = false
  }
}

/**
 * Start the in-process cron timer. Each machine runs independently;
 * document-level locks prevent duplicate work across machines.
 */
export function startCronTimer(fn: () => Promise<void>): void {
  console.log(`[cron] timer started: every ${CRON_INTERVAL_MS / 60000}min on machine=${MACHINE_ID}`)

  setInterval(async () => {
    await runCronGuarded(fn)
  }, CRON_INTERVAL_MS)
}
