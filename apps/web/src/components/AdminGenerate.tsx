import { createSignal, Show } from 'solid-js'

interface Props {
  documentId: string
}

export default function AdminGenerate(props: Props) {
  const [count, setCount] = createSignal(10)
  const [loading, setLoading] = createSignal(false)
  const [result, setResult] = createSignal<{
    generated: number
    totalCards: number
    processingStatus: string
  } | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const generate = async () => {
    setLoading(true)
    setResult(null)
    setError(null)

    try {
      const res = await fetch('/api/admin/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: props.documentId, count: count() }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`)
        return
      }

      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="rounded border border-dashed border-ed-outline-dim bg-ed-surface-high px-5 py-4 space-y-3">
      <p class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-on-surface-muted">
        Admin — Generate Cards
      </p>
      <div class="flex items-center gap-2">
        <input
          type="number"
          min="1"
          max="100"
          value={count()}
          onInput={(e) => setCount(Math.min(100, Math.max(1, parseInt(e.currentTarget.value) || 1)))}
          class="w-16 rounded bg-ed-surface px-2 py-1 font-body text-sm text-ed-on-surface border border-ed-surface-highest focus:border-ed-primary focus:outline-none"
        />
        <button
          onClick={generate}
          disabled={loading()}
          class="rounded bg-ed-primary px-4 py-1 font-body text-sm font-medium text-ed-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {loading() ? 'Generating...' : 'Generate'}
        </button>
        <span class="font-body text-xs text-ed-on-surface-muted">cards (bypasses daily limit)</span>
      </div>

      <Show when={result()}>
        {(r) => (
          <p class="font-body text-xs text-green-400">
            Generated {r().generated} cards — total now {r().totalCards} (status: {r().processingStatus})
          </p>
        )}
      </Show>

      <Show when={error()}>
        {(msg) => (
          <p class="font-body text-xs text-red-400">{msg()}</p>
        )}
      </Show>
    </div>
  )
}
