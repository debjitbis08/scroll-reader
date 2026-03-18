import { createSignal, onCleanup, onMount } from 'solid-js'

interface Props {
  jobId: string
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Waiting in queue…',
  processing: 'Processing document…',
  done: 'Done! Loading cards…',
  failed: 'Processing failed.',
}

export default function JobPoller(props: Props) {
  const [status, setStatus] = createSignal('queued')
  const [error, setError] = createSignal<string | null>(null)

  let interval: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${props.jobId}`)
        if (!res.ok) return
        const job = await res.json()
        setStatus(job.status)
        if (job.status === 'done') {
          clearInterval(interval)
          window.location.reload()
        } else if (job.status === 'failed') {
          clearInterval(interval)
          setError(job.error ?? 'An unknown error occurred.')
        }
      } catch {
        // network hiccup — try again next tick
      }
    }, 2500)
  })

  onCleanup(() => clearInterval(interval))

  return (
    <div class="flex flex-col items-center gap-4 py-16 text-center">
      {status() !== 'failed' && (
        <svg
          class="size-10 animate-spin text-ctp-mauve"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      )}
      <p class="text-lg font-medium text-ctp-text">{STATUS_LABELS[status()] ?? status()}</p>
      {error() && (
        <p class="max-w-sm rounded-lg bg-ctp-red/10 px-4 py-2 text-sm text-ctp-red">{error()}</p>
      )}
    </div>
  )
}
