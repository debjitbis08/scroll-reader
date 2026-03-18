import { onCleanup, onMount } from 'solid-js'

interface Props {
  jobId: string
  intervalMs?: number
}

/**
 * Polls the job status and reloads the page periodically while the job is active.
 * Used during the "generating" phase so new cards appear as they're created.
 */
export default function AutoRefresh(props: Props) {
  let interval: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${props.jobId}`)
        if (!res.ok) return
        const job = await res.json()
        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(interval)
        }
        window.location.reload()
      } catch {
        // network hiccup — try again next tick
      }
    }, props.intervalMs ?? 5000)
  })

  onCleanup(() => clearInterval(interval))

  return null
}
