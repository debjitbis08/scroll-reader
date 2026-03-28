import { createSignal, onMount, For, Show } from 'solid-js'

interface Collection {
  id: string
  name: string
  description: string | null
  documentCount: number
}

interface Props {
  documentId: string
  initialCollectionIds: string[]
}

export default function CollectionManager(props: Props) {
  const [collections, setCollections] = createSignal<Collection[]>([])
  const [memberIds, setMemberIds] = createSignal<Set<string>>(new Set(props.initialCollectionIds))
  const [query, setQuery] = createSignal('')
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)

  onMount(async () => {
    const res = await fetch('/api/collections')
    if (res.ok) setCollections(await res.json())
  })

  const memberCollections = () => collections().filter((c) => memberIds().has(c.id))
  const filtered = () => {
    const q = query().toLowerCase()
    if (!q) return collections().filter((c) => !memberIds().has(c.id))
    return collections().filter((c) => !memberIds().has(c.id) && c.name.toLowerCase().includes(q))
  }
  const canCreate = () => {
    const q = query().trim()
    if (!q) return false
    return !collections().some((c) => c.name.toLowerCase() === q.toLowerCase())
  }

  async function add(collectionId: string) {
    setLoading(true)
    const res = await fetch(`/api/collections/${collectionId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: props.documentId }),
    })
    if (res.ok || res.status === 204) {
      setMemberIds((prev) => new Set([...prev, collectionId]))
    }
    setLoading(false)
  }

  async function remove(collectionId: string) {
    setLoading(true)
    const res = await fetch(`/api/collections/${collectionId}/documents/${props.documentId}`, {
      method: 'DELETE',
    })
    if (res.ok || res.status === 204) {
      setMemberIds((prev) => {
        const next = new Set(prev)
        next.delete(collectionId)
        return next
      })
    }
    setLoading(false)
  }

  async function createAndAdd() {
    const name = query().trim()
    if (!name) return
    setLoading(true)
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok || res.status === 201) {
      const created = await res.json()
      setCollections((prev) => [...prev, { ...created, documentCount: 0 }])
      await add(created.id)
      setQuery('')
    }
    setLoading(false)
  }

  return (
    <div>
      <div class="flex items-center gap-2 mb-2">
        <span class="font-body text-sm tracking-wide text-ed-on-surface-muted">Collections:</span>
        <button
          onClick={() => setOpen(!open())}
          class="rounded px-2 py-0.5 font-body text-xs text-ed-primary hover:bg-ed-surface-high transition-colors"
        >
          {open() ? 'Done' : '+ Edit'}
        </button>
      </div>

      {/* Current memberships */}
      <div class="flex flex-wrap gap-1.5">
        <For each={memberCollections()}>
          {(col) => (
            <span class="inline-flex items-center gap-1 rounded bg-ed-primary-container px-2 py-0.5 font-body text-xs text-ed-on-primary-container">
              {col.name}
              <Show when={open()}>
                <button
                  onClick={() => remove(col.id)}
                  disabled={loading()}
                  class="ml-0.5 text-ed-on-primary-container/60 hover:text-ed-on-primary-container transition-colors"
                  title={`Remove from ${col.name}`}
                >
                  &times;
                </button>
              </Show>
            </span>
          )}
        </For>
        <Show when={memberCollections().length === 0 && !open()}>
          <span class="font-body text-xs text-ed-on-surface-muted italic">None</span>
        </Show>
      </div>

      {/* Search + add UI */}
      <Show when={open()}>
        <div class="mt-3 space-y-2">
          <input
            type="text"
            placeholder="Search or create collection..."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate()) createAndAdd()
            }}
            class="w-full rounded border border-ed-outline-dim bg-ed-surface px-3 py-1.5 font-body text-sm text-ed-on-surface placeholder:text-ed-on-surface-muted outline-none focus:border-ed-primary transition-colors"
          />
          <div class="max-h-40 overflow-y-auto space-y-0.5">
            <For each={filtered()}>
              {(col) => (
                <button
                  onClick={() => add(col.id)}
                  disabled={loading()}
                  class="flex w-full items-center justify-between rounded px-3 py-1.5 text-left font-body text-sm text-ed-on-surface-dim hover:bg-ed-surface-high transition-colors"
                >
                  <span>{col.name}</span>
                  <span class="text-xs text-ed-on-surface-muted">{col.documentCount} docs</span>
                </button>
              )}
            </For>
            <Show when={canCreate()}>
              <button
                onClick={createAndAdd}
                disabled={loading()}
                class="flex w-full items-center gap-1.5 rounded px-3 py-1.5 text-left font-body text-sm text-ed-primary hover:bg-ed-surface-high transition-colors"
              >
                + Create "{query().trim()}"
              </button>
            </Show>
            <Show when={filtered().length === 0 && !canCreate() && query().length > 0}>
              <p class="px-3 py-1.5 font-body text-xs text-ed-on-surface-muted italic">No matching collections</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
