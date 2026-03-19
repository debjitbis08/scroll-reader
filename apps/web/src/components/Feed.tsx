import { createSignal, onMount, onCleanup, For, Show, type JSX } from 'solid-js'
import { FaRegularHeart, FaSolidHeart } from 'solid-icons/fa'
import { FaRegularBookmark, FaSolidBookmark } from 'solid-icons/fa'
import { FiEyeOff, FiChevronLeft, FiChevronRight } from 'solid-icons/fi'
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
  icon: JSX.Element
  activeIcon: JSX.Element
  activeClass: string
  title: string
  onToggle?: (active: boolean) => void
}) {
  const [active, setActive] = createSignal(props.active)
  const [loading, setLoading] = createSignal(false)

  async function toggle() {
    if (loading()) return
    const prev = active()
    const next = !prev
    setActive(next)
    props.onToggle?.(next)
    setLoading(true)
    try {
      const res = await fetch(`/api/cards/${props.cardId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: props.action }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.active !== next) {
          setActive(data.active)
          props.onToggle?.(data.active)
        }
      } else {
        setActive(prev)
        props.onToggle?.(prev)
      }
    } catch {
      setActive(prev)
      props.onToggle?.(prev)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading()}
      title={props.title}
      class={`rounded-md p-1.5 transition-colors ${
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
        {(item) => {
          const [dismissed, setDismissed] = createSignal(item.actions.includes('dismiss'))

          return (
            <Show when={!dismissed()}>
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

                <div>
                  <LatexText text={item.card.front} class="text-sm leading-relaxed text-ctp-text" />
                  <Show when={item.card.back}>
                    <LatexText text={item.card.back!} class="mt-1 text-sm leading-relaxed text-ctp-subtext0" />
                  </Show>
                </div>

                {(() => {
                  type ChunkData = {
                    content: string
                    chunkType: string
                    chunkIndex: number
                    chapter: string | null
                    language: string | null
                  }
                  const [open, setOpen] = createSignal(false)
                  const [currentChunk, setCurrentChunk] = createSignal<ChunkData>({
                    content: item.chunk.content,
                    chunkType: item.chunk.chunkType,
                    chunkIndex: item.chunk.chunkIndex,
                    chapter: item.chunk.chapter,
                    language: item.chunk.language,
                  })
                  const [fetching, setFetching] = createSignal(false)
                  const [atStart, setAtStart] = createSignal(item.chunk.chunkIndex === 0)

                  async function navigate(direction: -1 | 1) {
                    if (fetching()) return
                    const nextIndex = currentChunk().chunkIndex + direction
                    if (nextIndex < 0) return
                    setFetching(true)
                    try {
                      const res = await fetch(
                        `/api/chunks/adjacent?documentId=${item.document.id}&chunkIndex=${nextIndex}`,
                      )
                      if (res.ok) {
                        const data: ChunkData = await res.json()
                        setCurrentChunk(data)
                        setAtStart(data.chunkIndex === 0)
                      } else if (res.status === 404) {
                        if (direction === -1) setAtStart(true)
                      }
                    } finally {
                      setFetching(false)
                    }
                  }

                  return (
                    <div>
                      <button
                        onClick={() => setOpen(!open())}
                        class="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors"
                      >
                        source {open() ? '↑' : '↓'}
                      </button>
                      <Show when={open()}>
                        <div class="mt-2 space-y-2">
                          <Show when={!fetching()} fallback={
                            <div class="flex justify-center rounded-lg bg-ctp-surface0 px-3 py-6">
                              <div class="size-5 animate-spin rounded-full border-2 border-ctp-surface2 border-t-ctp-mauve" />
                            </div>
                          }>
                            {(() => {
                              const c = currentChunk()
                              return c.chunkType === 'code' ? (
                                <div class="relative">
                                  {c.language && (
                                    <span class="absolute right-2 top-2 text-xs text-ctp-subtext0/60 font-mono">
                                      {c.language}
                                    </span>
                                  )}
                                  <pre class="overflow-x-auto rounded-lg bg-ctp-mantle p-3 text-xs leading-relaxed max-h-48">
                                    <code class="text-ctp-text font-mono whitespace-pre">{c.content}</code>
                                  </pre>
                                </div>
                              ) : (
                                <p class="rounded-lg bg-ctp-surface0 px-3 py-2 text-xs leading-relaxed text-ctp-subtext1">
                                  {c.content}
                                </p>
                              )
                            })()}
                          </Show>
                          <div class="flex items-center justify-between">
                            <button
                              onClick={() => navigate(-1)}
                              disabled={fetching() || atStart()}
                              class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ctp-subtext0 transition-colors hover:text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:pointer-events-none"
                            >
                              <FiChevronLeft class="size-3.5" /> prev
                            </button>
                            <Show when={currentChunk().chunkIndex !== item.chunk.chunkIndex}>
                              <button
                                onClick={() => {
                                  setCurrentChunk({
                                    content: item.chunk.content,
                                    chunkType: item.chunk.chunkType,
                                    chunkIndex: item.chunk.chunkIndex,
                                    chapter: item.chunk.chapter,
                                    language: item.chunk.language,
                                  })
                                  setAtStart(item.chunk.chunkIndex === 0)
                                }}
                                class="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors"
                              >
                                back to source
                              </button>
                            </Show>
                            <button
                              onClick={() => navigate(1)}
                              disabled={fetching()}
                              class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ctp-subtext0 transition-colors hover:text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:pointer-events-none"
                            >
                              next <FiChevronRight class="size-3.5" />
                            </button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  )
                })()}

                <div class="flex items-center gap-1 pt-1">
                  <ActionButton
                    cardId={item.card.id}
                    action="like"
                    active={item.actions.includes('like')}
                    icon={<FaRegularHeart class="size-4" />}
                    activeIcon={<FaSolidHeart class="size-4" />}
                    activeClass="text-ctp-red"
                    title="Like"
                  />
                  <ActionButton
                    cardId={item.card.id}
                    action="bookmark"
                    active={item.actions.includes('bookmark')}
                    icon={<FaRegularBookmark class="size-4" />}
                    activeIcon={<FaSolidBookmark class="size-4" />}
                    activeClass="text-ctp-yellow"
                    title="Bookmark"
                  />
                  <ActionButton
                    cardId={item.card.id}
                    action="dismiss"
                    active={item.actions.includes('dismiss')}
                    icon={<FiEyeOff class="size-4" />}
                    activeIcon={<FiEyeOff class="size-4" />}
                    activeClass="text-ctp-surface2"
                    title="Dismiss"
                    onToggle={(active) => { if (active) setDismissed(true) }}
                  />
                </div>
              </div>
            </Show>
          )
        }}
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
