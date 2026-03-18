import { createSignal } from 'solid-js'

interface Props {
  docId: string
  totalPages: number
  initialStart: number
  initialEnd: number
}

export default function PageRangeSelector(props: Props) {
  const [start, setStart] = createSignal(props.initialStart)
  const [end, setEnd] = createSignal(props.initialEnd)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const handleSubmit = async () => {
    if (start() < 1 || end() > props.totalPages || start() > end()) {
      setError('Invalid page range.')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/documents/${props.docId}/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageStart: start(), pageEnd: end() }),
      })

      if (!res.ok) {
        const msg = await res.text()
        setError(msg || 'Failed to start processing.')
        setSubmitting(false)
        return
      }

      window.location.reload()
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div class="rounded-xl border border-ctp-surface1 bg-ctp-surface0 p-6 space-y-6">
      <div class="space-y-2">
        <h2 class="text-lg font-semibold text-ctp-text">Select pages to process</h2>
        <p class="text-sm text-ctp-subtext0">
          This document has {props.totalPages} page{props.totalPages !== 1 ? 's' : ''}.
          Adjust the range to skip frontmatter, table of contents, or other pages you don't need.
        </p>
      </div>

      <div class="flex items-center gap-3">
        <label class="text-sm text-ctp-subtext1">Pages</label>
        <input
          type="number"
          min={1}
          max={props.totalPages}
          value={start()}
          onInput={(e) => setStart(parseInt(e.currentTarget.value, 10) || 1)}
          class="w-20 rounded-lg border border-ctp-surface2 bg-ctp-base px-3 py-2 text-sm text-ctp-text focus:border-ctp-mauve focus:outline-none"
        />
        <span class="text-sm text-ctp-subtext0">to</span>
        <input
          type="number"
          min={1}
          max={props.totalPages}
          value={end()}
          onInput={(e) => setEnd(parseInt(e.currentTarget.value, 10) || props.totalPages)}
          class="w-20 rounded-lg border border-ctp-surface2 bg-ctp-base px-3 py-2 text-sm text-ctp-text focus:border-ctp-mauve focus:outline-none"
        />
        <span class="text-sm text-ctp-subtext0">of {props.totalPages}</span>
      </div>

      {error() && (
        <p class="text-sm text-ctp-red">{error()}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={submitting()}
        class="rounded-lg bg-ctp-mauve px-6 py-2.5 text-sm font-medium text-ctp-base transition-colors hover:bg-ctp-mauve/90 disabled:opacity-50"
      >
        {submitting() ? 'Starting…' : 'Start processing'}
      </button>
    </div>
  )
}
