import { createSignal, createMemo } from 'solid-js'
import type { DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { resolveCardStrategy, describeStrategy } from '@scroll-reader/shared-types'

interface Props {
  docId: string
  totalPages: number
  initialStart: number
  initialEnd: number
}

const CONTENT_OPTIONS: { label: string; value: DocumentType }[] = [
  { label: 'Fiction / novel', value: 'fiction' },
  { label: 'Spiritual / philosophical', value: 'scripture' },
  { label: 'Non-fiction', value: 'book' },
  { label: 'Textbook / technical', value: 'manual' },
]

const GOAL_OPTIONS: { label: string; value: ReadingGoal }[] = [
  { label: 'Just reading', value: 'casual' },
  { label: 'Reading to reflect', value: 'reflective' },
  { label: 'Studying to retain', value: 'study' },
]

export default function PageRangeSelector(props: Props) {
  const [start, setStart] = createSignal(props.initialStart)
  const [end, setEnd] = createSignal(props.initialEnd)
  const [documentType, setDocumentType] = createSignal<DocumentType>('book')
  const [readingGoal, setReadingGoal] = createSignal<ReadingGoal>('reflective')
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const strategy = createMemo(() => resolveCardStrategy(documentType(), readingGoal()))
  const strategyLabel = createMemo(() => describeStrategy(strategy()))

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
        body: JSON.stringify({
          pageStart: start(),
          pageEnd: end(),
          documentType: documentType(),
          readingGoal: readingGoal(),
        }),
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
        <h2 class="text-lg font-semibold text-ctp-text">Configure processing</h2>
        <p class="text-sm text-ctp-subtext0">
          This document has {props.totalPages} page{props.totalPages !== 1 ? 's' : ''}.
        </p>
      </div>

      {/* Page range */}
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

      {/* Content type */}
      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-ctp-text">What kind of content is this?</legend>
        <div class="flex flex-wrap gap-2">
          {CONTENT_OPTIONS.map((opt) => (
            <label
              class={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                documentType() === opt.value
                  ? 'border-ctp-mauve bg-ctp-mauve/10 text-ctp-mauve'
                  : 'border-ctp-surface2 text-ctp-subtext1 hover:border-ctp-surface2 hover:bg-ctp-surface1'
              }`}
            >
              <input
                type="radio"
                name="documentType"
                value={opt.value}
                checked={documentType() === opt.value}
                onChange={() => setDocumentType(opt.value)}
                class="sr-only"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Reading goal */}
      <fieldset class="space-y-2">
        <legend class="text-sm font-medium text-ctp-text">What's your goal?</legend>
        <div class="flex flex-wrap gap-2">
          {GOAL_OPTIONS.map((opt) => (
            <label
              class={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                readingGoal() === opt.value
                  ? 'border-ctp-mauve bg-ctp-mauve/10 text-ctp-mauve'
                  : 'border-ctp-surface2 text-ctp-subtext1 hover:border-ctp-surface2 hover:bg-ctp-surface1'
              }`}
            >
              <input
                type="radio"
                name="readingGoal"
                value={opt.value}
                checked={readingGoal() === opt.value}
                onChange={() => setReadingGoal(opt.value)}
                class="sr-only"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Strategy preview */}
      <p class="text-sm text-ctp-subtext0 italic">
        {strategyLabel()}
      </p>

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
