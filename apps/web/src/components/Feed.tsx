import { createSignal, onMount, onCleanup, For, Show, Switch, Match, type JSX } from 'solid-js'
import { FaRegularHeart, FaSolidHeart } from 'solid-icons/fa'
import { FaRegularBookmark, FaSolidBookmark } from 'solid-icons/fa'
import { FiEyeOff, FiChevronLeft, FiChevronRight } from 'solid-icons/fi'
import LatexText from './LatexText.tsx'
import FlashcardRenderer from './cards/FlashcardRenderer.tsx'
import QuizRenderer from './cards/QuizRenderer.tsx'
import GlossaryRenderer from './cards/GlossaryRenderer.tsx'
import ContrastRenderer from './cards/ContrastRenderer.tsx'
import PassageRenderer from './cards/PassageRenderer.tsx'
import CardImages from './cards/CardImages.tsx'
import type { CardContent, BodyContent, FlashcardContent, QuizContent, GlossaryContent, ContrastContent, PassageContent } from '@scroll-reader/shared-types'

interface FeedCard {
  card: {
    id: string
    cardType: string
    content: CardContent
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
  isSrDue: boolean
  wordCount: number
  chunkImageUrls: { url: string; alt: string }[]
}

// --- Impression tracking ---

interface PendingImpression {
  cardId: string
  durationMs: number
  wasSrDue: boolean
  timestamp: number
}

const FLUSH_INTERVAL_MS = 10_000
const MAX_BUFFER_SIZE = 20

const impressionState = {
  currentCardId: null as string | null,
  currentSrDue: false,
  startTime: null as number | null,
  buffer: [] as PendingImpression[],
}

function bufferImpression(cardId: string, durationMs: number, wasSrDue: boolean) {
  impressionState.buffer.push({ cardId, durationMs, wasSrDue, timestamp: Date.now() })
  if (impressionState.buffer.length >= MAX_BUFFER_SIZE) {
    flushImpressions()
  }
}

function flushImpressions() {
  if (impressionState.buffer.length === 0) return
  const batch = impressionState.buffer.splice(0)
  fetch('/api/feed-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impressions: batch }),
    keepalive: true,
  }).catch(() => {})
}

function flushCurrentAndBuffer() {
  if (impressionState.currentCardId && impressionState.startTime) {
    const duration = Date.now() - impressionState.startTime
    bufferImpression(impressionState.currentCardId, duration, impressionState.currentSrDue)
    impressionState.currentCardId = null
    impressionState.startTime = null
  }
  flushImpressions()
}

function getOwnerCard(cardElements: Element[]): Element | null {
  const viewportMid = window.innerHeight / 2

  return cardElements.reduce((closest, card) => {
    const rect = card.getBoundingClientRect()
    const cardMid = rect.top + rect.height / 2
    const distance = Math.abs(cardMid - viewportMid)

    if (!closest) return card

    const closestRect = closest.getBoundingClientRect()
    const closestMid = closestRect.top + closestRect.height / 2
    const closestDistance = Math.abs(closestMid - viewportMid)

    return distance < closestDistance ? card : closest
  }, null as Element | null)
}

function throttle<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let last = 0
  return ((...args: unknown[]) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    }
  }) as T
}

// --- Card type constants ---

const CARD_TYPE_LABEL: Record<string, string> = {
  discover: 'Discovery',
  raw_commentary: 'Notes',
  flashcard: 'Active Recall',
  quiz: 'Quiz',
  glossary: 'Glossary',
  contrast: 'Contrast',
  passage: 'Passage',
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
      class={`rounded p-1.5 transition-colors ${
        active()
          ? props.activeClass
          : 'text-ed-on-surface-muted hover:text-ed-on-surface-dim'
      }`}
    >
      {active() ? props.activeIcon : props.icon}
    </button>
  )
}

export default function Feed() {
  const [cards, setCards] = createSignal<FeedCard[]>([])
  const [loading, setLoading] = createSignal(false)
  const [initialLoaded, setInitialLoaded] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let sentinelRef: HTMLDivElement | undefined

  async function loadMore() {
    if (loading() || !hasMore()) return
    setLoading(true)
    try {
      const existingIds = cards().map((c) => c.card.id)
      const excludeParam = existingIds.length > 0 ? `&exclude=${existingIds.join(',')}` : ''
      const res = await fetch(`/api/feed?limit=${BATCH_SIZE}${excludeParam}`)
      if (!res.ok) throw new Error(`Failed to load feed: ${res.status}`)
      const batch: FeedCard[] = await res.json()
      if (batch.length === 0) setHasMore(false)
      // Deduplicate in case of any overlap
      const existingSet = new Set(existingIds)
      const newCards = batch.filter((c) => !existingSet.has(c.card.id))
      setCards((prev) => [...prev, ...newCards])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed')
    } finally {
      setLoading(false)
      setInitialLoaded(true)
      // If sentinel is still visible after loading (content didn't fill viewport),
      // schedule another check since no scroll event will fire.
      requestAnimationFrame(checkSentinel)
    }
  }

  function checkSentinel() {
    if (!sentinelRef || loading() || !hasMore()) return
    const rect = sentinelRef.getBoundingClientRect()
    if (rect.top < window.innerHeight + 600) {
      loadMore()
    }
  }

  // Combined scroll handler: impression tracking + infinite scroll sentinel check
  const handleScrollAndSentinel = throttle(() => {
    // Impression tracking
    const owner = getOwnerCard(
      Array.from(document.querySelectorAll('[data-card-id]')),
    )
    if (owner) {
      const cardId = (owner as HTMLElement).dataset.cardId!
      if (cardId !== impressionState.currentCardId) {
        if (impressionState.currentCardId && impressionState.startTime) {
          const duration = Date.now() - impressionState.startTime
          bufferImpression(impressionState.currentCardId, duration, impressionState.currentSrDue)
        }
        impressionState.currentCardId = cardId
        impressionState.currentSrDue = (owner as HTMLElement).dataset.srDue === 'true'
        impressionState.startTime = Date.now()
      }
    }

    // Infinite scroll
    checkSentinel()
  }, 100)

  onMount(() => {
    loadMore()

    window.addEventListener('scroll', handleScrollAndSentinel, { passive: true })
    const flushInterval = setInterval(flushImpressions, FLUSH_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', flushCurrentAndBuffer)

    onCleanup(() => {
      window.removeEventListener('scroll', handleScrollAndSentinel)
      clearInterval(flushInterval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', flushCurrentAndBuffer)
      flushCurrentAndBuffer()
    })
  })

  function onVisibilityChange() {
    if (document.hidden) flushCurrentAndBuffer()
  }

  return (
    <div class="flex flex-col gap-10">
      <Show when={error()}>
        <div class="rounded bg-ctp-red/10 px-6 py-4 font-body text-sm text-ctp-red">
          {error()}
        </div>
      </Show>

      <For each={cards()}>
        {(item) => {
          const [dismissed, setDismissed] = createSignal(item.actions.includes('dismiss'))

          return (
            <Show when={!dismissed()}>
              <div
                data-card-id={item.card.id}
                data-sr-due={item.isSrDue ? 'true' : 'false'}
              >
                {/* Card type label — outside the box */}
                <div class="mb-2">
                  <span class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
                    {CARD_TYPE_LABEL[item.card.cardType] ?? item.card.cardType}
                  </span>
                </div>

                {/* Card box */}
                <div class={`rounded p-6 ${item.card.cardType === 'flashcard' ? 'bg-ed-surface-dim' : 'bg-ed-surface-high'}`}>
                  {/* Card body */}
                  <div>
                    <Switch fallback={
                      <LatexText text={(item.card.content as BodyContent).body ?? ''} class="font-display text-[0.95rem] leading-relaxed text-ed-on-surface" />
                    }>
                    <Match when={item.card.cardType === 'discover'}>
                      <div class="space-y-3">
                        <Show when={(item.card.content as BodyContent).title}>
                          <h3 class="font-display text-xl leading-snug text-ed-on-surface">
                            {(item.card.content as BodyContent).title}
                          </h3>
                        </Show>
                        <LatexText text={(item.card.content as BodyContent).body ?? ''} class="font-body text-sm leading-relaxed text-ed-on-surface-dim" />
                      </div>
                    </Match>
                    <Match when={item.card.cardType === 'flashcard'}>
                      <FlashcardRenderer content={item.card.content as FlashcardContent} />
                    </Match>
                    <Match when={item.card.cardType === 'quiz'}>
                      <QuizRenderer content={item.card.content as QuizContent} />
                    </Match>
                    <Match when={item.card.cardType === 'glossary'}>
                      <GlossaryRenderer content={item.card.content as GlossaryContent} />
                    </Match>
                    <Match when={item.card.cardType === 'contrast'}>
                      <ContrastRenderer content={item.card.content as ContrastContent} />
                    </Match>
                    <Match when={item.card.cardType === 'passage'}>
                      <PassageRenderer content={item.card.content as PassageContent} />
                    </Match>
                  </Switch>
                  <Show when={
                    Array.isArray((item.card.content as Record<string, unknown>).images) &&
                    ((item.card.content as Record<string, unknown>).images as number[]).length > 0 &&
                    item.chunkImageUrls.length > 0
                  }>
                    <CardImages
                      indices={(item.card.content as Record<string, unknown>).images as number[]}
                      chunkImageUrls={item.chunkImageUrls}
                    />
                  </Show>
                  </div>

                {/* Source */}
                <div class="mt-4 flex items-center gap-1.5 text-ed-on-surface-muted">
                  <svg class="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <a
                    href={`/doc/${item.document.id}`}
                    class="truncate font-body text-[0.65rem] tracking-wide hover:text-ed-primary transition-colors"
                  >
                    {item.document.title}
                    {item.chunk.chapter && ` · ${item.chunk.chapter}`}
                  </a>
                </div>

                {/* Source chunk toggle */}
                {(() => {
                  type ChunkImage = {
                    storagePath: string
                    altText: string
                    position: number
                  }
                  type ChunkData = {
                    content: string
                    chunkType: string
                    chunkIndex: number
                    chapter: string | null
                    language: string | null
                    images?: ChunkImage[]
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
                    <div class="mt-2">
                      <button
                        onClick={() => setOpen(!open())}
                        class="font-body text-[0.65rem] text-ed-on-surface-muted hover:text-ed-on-surface-dim transition-colors"
                      >
                        source {open() ? '\u2191' : '\u2193'}
                      </button>
                      <Show when={open()}>
                        <div class="mt-2 space-y-2">
                          <Show when={!fetching()} fallback={
                            <div class="flex justify-center rounded bg-ed-surface-container px-3 py-6">
                              <div class="size-5 animate-spin rounded-full border-2 border-ed-outline border-t-ed-primary" />
                            </div>
                          }>
                            {(() => {
                              const c = currentChunk()
                              if (c.chunkType === 'code') {
                                return (
                                  <div class="relative">
                                    {c.language && (
                                      <span class="absolute right-2 top-2 font-body text-[0.65rem] text-ed-on-surface-muted">
                                        {c.language}
                                      </span>
                                    )}
                                    <pre class="overflow-x-auto rounded bg-ed-surface px-3 py-2 font-body text-xs leading-relaxed max-h-48">
                                      <code class="text-ed-on-surface whitespace-pre">{c.content}</code>
                                    </pre>
                                  </div>
                                )
                              }
                              if (c.chunkType === 'image' && c.images && c.images.length > 0) {
                                return (
                                  <div class="space-y-2 rounded bg-ed-surface-container px-3 py-2">
                                    <For each={c.images}>
                                      {(img) => (
                                        <img
                                          src={`/api/images/${img.storagePath}`}
                                          alt={img.altText || c.content || 'Document image'}
                                          class="max-w-full rounded"
                                          loading="lazy"
                                        />
                                      )}
                                    </For>
                                    <Show when={c.content}>
                                      <p class="font-body text-xs text-ed-on-surface-dim">{c.content}</p>
                                    </Show>
                                  </div>
                                )
                              }
                              return (
                                <div class="max-h-64 overflow-y-auto rounded bg-ed-surface-container px-3 py-2 font-body text-xs leading-relaxed text-ed-on-surface-dim whitespace-pre-line text-justify">
                                  {c.content}
                                </div>
                              )
                            })()}
                          </Show>
                          <div class="flex items-center justify-between">
                            <button
                              onClick={() => navigate(-1)}
                              disabled={fetching() || atStart()}
                              class="flex items-center gap-1 rounded px-2 py-1 font-body text-[0.65rem] text-ed-on-surface-muted transition-colors hover:text-ed-on-surface-dim disabled:opacity-30 disabled:pointer-events-none"
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
                                class="font-body text-[0.65rem] text-ed-on-surface-muted hover:text-ed-on-surface-dim transition-colors"
                              >
                                back to source
                              </button>
                            </Show>
                            <button
                              onClick={() => navigate(1)}
                              disabled={fetching()}
                              class="flex items-center gap-1 rounded px-2 py-1 font-body text-[0.65rem] text-ed-on-surface-muted transition-colors hover:text-ed-on-surface-dim disabled:opacity-30 disabled:pointer-events-none"
                            >
                              next <FiChevronRight class="size-3.5" />
                            </button>
                          </div>
                        </div>
                      </Show>
                    </div>
                  )
                })()}

                {/* Actions */}
                <div class="flex items-center gap-1 mt-3 pt-3 border-t border-ed-outline-dim">
                  <ActionButton
                    cardId={item.card.id}
                    action="like"
                    active={item.actions.includes('like')}
                    icon={<FaRegularHeart class="size-3.5" />}
                    activeIcon={<FaSolidHeart class="size-3.5" />}
                    activeClass="text-ctp-red"
                    title="Like"
                  />
                  <ActionButton
                    cardId={item.card.id}
                    action="bookmark"
                    active={item.actions.includes('bookmark')}
                    icon={<FaRegularBookmark class="size-3.5" />}
                    activeIcon={<FaSolidBookmark class="size-3.5" />}
                    activeClass="text-ed-primary"
                    title="Bookmark"
                  />
                  <ActionButton
                    cardId={item.card.id}
                    action="dismiss"
                    active={item.actions.includes('dismiss')}
                    icon={<FiEyeOff class="size-3.5" />}
                    activeIcon={<FiEyeOff class="size-3.5" />}
                    activeClass="text-ed-on-surface-muted"
                    title="Dismiss"
                    onToggle={(active) => { if (active) setDismissed(true) }}
                  />
                </div>
                </div>
              </div>
            </Show>
          )
        }}
      </For>

      <Show when={cards().length === 0 && initialLoaded() && !error()}>
        <div class="flex flex-col items-center gap-4 py-20 text-center">
          <p class="font-display text-lg text-ed-on-surface-dim">No cards in your feed yet.</p>
          <a
            href="/upload"
            class="rounded bg-ed-primary px-5 py-2.5 font-body text-sm font-medium text-ed-on-primary transition-colors hover:bg-ed-primary/80"
          >
            Upload a document
          </a>
        </div>
      </Show>

      <div ref={sentinelRef} class="h-1" />

      <Show when={loading() || !initialLoaded()}>
        <div class="flex justify-center py-6">
          <div class="size-5 animate-spin rounded-full border-2 border-ed-outline border-t-ed-primary" />
        </div>
      </Show>

    </div>
  )
}
