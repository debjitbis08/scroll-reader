import { spawn } from 'node:child_process'

/**
 * Spawn a binary, send JSON on stdin, return stdout as string.
 */
export function callBin(
  binPath: string,
  input: Record<string, unknown>,
  label = 'binary',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${label} exited ${code}: ${stderr.trim()}`))
      } else {
        resolve(stdout)
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${label} at "${binPath}": ${err.message}`))
    })

    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

/**
 * Spawn a Python script, send JSON on stdin, return stdout.
 * Tolerates non-zero exit if stdout looks like valid JSON (PyMuPDF quirk).
 */
export function callPython(
  scriptPath: string,
  input: Record<string, unknown>,
  label = 'python',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (stdout.trim().startsWith('[')) {
        resolve(stdout)
      } else if (code !== 0) {
        console.warn(`[${label}] exited ${code}: ${stderr.trim().slice(0, 200)}`)
        resolve('[]')
      } else {
        resolve(stdout)
      }
    })

    proc.on('error', () => {
      console.warn(`[${label}] python3 not available`)
      resolve('[]')
    })

    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}
