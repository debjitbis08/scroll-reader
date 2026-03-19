import { createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import LatexText from './LatexText.tsx'

interface FeedCard {
  card: {
    id: string
    cardType: string
    front: string
    back: string | null
  }
  chunk: {
    id: string
    content: string
    chapter: string | null
    chunkIndex: number
    chunkType: string
    language: string | null
  }
  document: {
    id: string
    title: string
    author: string | null
  }
  actions: string[]
}

const CARD_TYPE_LABEL: Record<string, string> = {
  discover: 'Discover',
  raw_commentary: 'Notes',
}

const CARD_TYPE_COLOR: Record<string, string> = {
  discover: 'text-ctp-blue',
  raw_commentary: 'text-ctp-green',
}

const CARD_TYPE_BG: Record<string, string> = {
  discover: 'border-ctp-blue/30',
  raw_commentary: 'border-ctp-green/30',
}

const BATCH_SIZE = 10

function ActionButton(props: {
  cardId: string
  action: string
  active: boolean
  icon: string
  activeIcon: string
  activeClass: string
  title: string
}) {
  const [active, setActive] = createSignal(props.active)
  const [loading, setLoading] = createSignal(false)

  async function toggle() {
    if (loading()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/cards/${props.cardId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: props.action }),
      })
      if (res.ok) {
        const data = await res.json()
        setActive(data.active)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading()}
      title={props.title}
      class={`rounded-md p-1.5 text-sm transition-colors ${
        active()
          ? props.activeClass
          : 'text-ctp-subtext0 hover:text-ctp-text hover:bg-ctp-surface1'
      }`}
    >
      {active() ? props.activeIcon : props.icon}
    </button>
  )
}

export default function Feed() {
  const [cards, setCards] = createSignal<FeedCard[]>([])
  const [loading, setLoading] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let sentinelRef: HTMLDivElement | undefined
  let observer: IntersectionObserver | undefined

  async function loadMore() {
    if (loading() || !hasMore()) return
    setLoading(true)
    try {
      const res = await fetch(`/api/feed?limit=${BATCH_SIZE}&offset=${cards().length}`)
      if (!res.ok) throw new Error(`Failed to load feed: ${res.status}`)
      const batch: FeedCard[] = await res.json()
      if (batch.length < BATCH_SIZE) setHasMore(false)
      setCards((prev) => [...prev, ...batch])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    loadMore()

    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { rootMargin: '200px' },
    )

    if (sentinelRef) observer.observe(sentinelRef)
  })

  onCleanup(() => observer?.disconnect())

  return (
    <div class="space-y-6">
      <Show when={error()}>
        <div class="rounded-xl bg-ctp-red/10 px-6 py-4 text-sm text-ctp-red">
          {error()}
        </div>
      </Show>

      <For each={cards()}>
        {(item) => (
          <div class={`rounded-xl border bg-ctp-surface0/50 p-5 space-y-3 ${CARD_TYPE_BG[item.card.cardType] ?? 'border-ctp-surface1'}`}>
            <div class="flex items-center justify-between gap-2">
              <span class={`text-xs font-semibold uppercase tracking-wide ${CARD_TYPE_COLOR[item.card.cardType] ?? 'text-ctp-subtext0'}`}>
                {CARD_TYPE_LABEL[item.card.cardType] ?? item.card.cardType}
              </span>
              <a
                href={`/doc/${item.document.id}`}
                class="truncate text-xs text-ctp-subtext0 hover:text-ctp-mauve"
              >
                {item.document.title}
                {item.chunk.chapter && ` · ${item.chunk.chapter}`}
              </a>
            </div>

            {item.chunk.chunkType === 'code' ? (
              <div class="relative">
                {item.chunk.language && (
                  <span class="absolute right-2 top-2 text-xs text-ctp-subtext0/60 font-mono">
                    {item.chunk.language}
                  </span>
                )}
                <pre class="overflow-x-auto rounded-lg bg-ctp-mantle p-3 text-xs leading-relaxed max-h-48">
                  <code class="text-ctp-text font-mono whitespace-pre">{item.chunk.content}</code>
                </pre>
              </div>
            ) : (
              <p class="text-sm leading-relaxed text-ctp-text line-clamp-6">
                {item.chunk.content}
              </p>
            )}

            <div class="border-t border-ctp-surface1 pt-3">
              <LatexText text={item.card.front} class="text-sm leading-relaxed text-ctp-subtext1" />
              <Show when={item.card.back}>
                <LatexText text={item.card.back!} class="mt-1 text-sm leading-relaxed text-ctp-subtext0" />
              </Show>
            </div>

            <div class="flex items-center gap-1 pt-1">
              <ActionButton
                cardId={item.card.id}
                action="like"
                active={item.actions.includes('like')}
                icon="♡"
                activeIcon="♥"
                activeClass="text-ctp-red"
                title="Like"
              />
              <ActionButton
                cardId={item.card.id}
                action="bookmark"
                active={item.actions.includes('bookmark')}
                icon="☆"
                activeIcon="★"
                activeClass="text-ctp-yellow"
                title="Bookmark"
              />
              <ActionButton
                cardId={item.card.id}
                action="dismiss"
                active={item.actions.includes('dismiss')}
                icon="✕"
                activeIcon="✕"
                activeClass="text-ctp-surface2 line-through"
                title="Dismiss"
              />
            </div>
          </div>
        )}
      </For>

      <Show when={cards().length === 0 && !loading() && !error()}>
        <div class="flex flex-col items-center gap-3 py-20 text-center">
          <p class="text-ctp-subtext0">No cards in your feed yet.</p>
          <a
            href="/upload"
            class="rounded-lg bg-ctp-mauve px-4 py-2 text-sm font-medium text-ctp-base transition-colors hover:bg-ctp-mauve/80"
          >
            Upload a document
          </a>
        </div>
      </Show>

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} class="h-1" />

      <Show when={loading()}>
        <div class="flex justify-center py-6">
          <svg
            class="size-6 animate-spin text-ctp-mauve"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>
      </Show>
    </div>
  )
}
