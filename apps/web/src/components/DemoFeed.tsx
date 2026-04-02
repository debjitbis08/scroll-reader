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

// --- Types matching Feed.tsx ---

export interface DemoFeedCard {
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
  /** Adjacent chunks for source navigation, keyed by chunkIndex */
  adjacentChunks?: Record<number, {
    content: string
    chunkType: string
    chunkIndex: number
    chapter: string | null
    language: string | null
  }>
}

// --- Card type constants (same as Feed.tsx) ---

const CARD_TYPE_LABEL: Record<string, string> = {
  discover: 'Discovery',
  raw_commentary: 'Notes',
  flashcard: 'Active Recall',
  quiz: 'Quiz',
  glossary: 'Glossary',
  contrast: 'Contrast',
  passage: 'Passage',
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

const BATCH_SIZE = 10

// --- Dummy ActionButton (client-only toggle, no fetch) ---

function DemoActionButton(props: {
  action: string
  active: boolean
  icon: JSX.Element
  activeIcon: JSX.Element
  activeClass: string
  title: string
  onToggle?: (active: boolean) => void
}) {
  const [active, setActive] = createSignal(props.active)

  function toggle() {
    const next = !active()
    setActive(next)
    props.onToggle?.(next)
  }

  return (
    <button
      onClick={toggle}
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

// --- Main component ---

export default function DemoFeed(props: { dataUrl: string }) {
  const [allCards, setAllCards] = createSignal<DemoFeedCard[]>([])
  const [cards, setCards] = createSignal<DemoFeedCard[]>([])
  const [loading, setLoading] = createSignal(false)
  const [initialLoaded, setInitialLoaded] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  let sentinelRef: HTMLDivElement | undefined

  async function fetchData() {
    try {
      const res = await fetch(props.dataUrl)
      if (!res.ok) throw new Error(`Failed to load demo data: ${res.status}`)
      const data: DemoFeedCard[] = await res.json()
      setAllCards(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load demo data')
    }
  }

  function loadMore() {
    if (loading() || !hasMore()) return
    setLoading(true)

    // Simulate network delay for realistic feel
    setTimeout(() => {
      const all = allCards()
      const current = cards()
      const nextBatch = all.slice(current.length, current.length + BATCH_SIZE)

      if (nextBatch.length === 0) {
        setHasMore(false)
      } else {
        setCards((prev) => [...prev, ...nextBatch])
        if (current.length + nextBatch.length >= all.length) {
          setHasMore(false)
        }
      }

      setLoading(false)
      setInitialLoaded(true)
      requestAnimationFrame(checkSentinel)
    }, 300)
  }

  function checkSentinel() {
    if (!sentinelRef || loading() || !hasMore()) return
    const rect = sentinelRef.getBoundingClientRect()
    if (rect.top < window.innerHeight + 600) {
      loadMore()
    }
  }

  const handleScroll = throttle(() => {
    checkSentinel()
  }, 100)

  onMount(async () => {
    await fetchData()
    loadMore()

    window.addEventListener('scroll', handleScroll, { passive: true })

    onCleanup(() => {
      window.removeEventListener('scroll', handleScroll)
    })
  })

  return (
    <div class="flex flex-col gap-10">
      <Show when={error()}>
        <div class="rounded bg-ctp-red/10 px-6 py-4 font-body text-sm text-ctp-red">
          {error()}
        </div>
      </Show>

      <For each={cards()}>
        {(item) => {
          const [dismissed, setDismissed] = createSignal(false)

          return (
            <Show when={!dismissed()}>
              <div
                data-card-id={item.card.id}
                data-card-type={item.card.cardType}
                data-sr-due={item.isSrDue ? 'true' : 'false'}
              >
                {/* Card type label + document title — outside the box */}
                <div class="mb-2 flex items-baseline justify-between gap-2">
                  <span class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
                    {CARD_TYPE_LABEL[item.card.cardType] ?? item.card.cardType}
                  </span>
                  <span class="truncate font-body text-[0.65rem] tracking-wide text-ed-on-surface-muted">
                    {item.document.title}
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
                      <FlashcardRenderer
                        content={item.card.content as FlashcardContent}
                        onReveal={() => {}}
                        onGrade={() => {}}
                      />
                    </Match>
                    <Match when={item.card.cardType === 'quiz'}>
                      <QuizRenderer
                        content={item.card.content as QuizContent}
                        onAnswer={() => {}}
                      />
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

                {/* Source chunk toggle */}
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
                  const [atStart, setAtStart] = createSignal(item.chunk.chunkIndex === 0)

                  function navigate(direction: -1 | 1) {
                    const nextIndex = currentChunk().chunkIndex + direction
                    if (nextIndex < 0) return
                    const adjacent = item.adjacentChunks?.[nextIndex]
                    if (adjacent) {
                      setCurrentChunk(adjacent)
                      setAtStart(adjacent.chunkIndex === 0)
                    } else if (direction === -1) {
                      setAtStart(true)
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
                            return (
                              <div class="max-h-64 overflow-y-auto rounded bg-ed-surface-container px-3 py-2 font-body text-xs leading-relaxed text-ed-on-surface-dim whitespace-pre-line text-justify">
                                {c.content}
                              </div>
                            )
                          })()}
                          <div class="flex items-center justify-between">
                            <button
                              onClick={() => navigate(-1)}
                              disabled={atStart()}
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
                              disabled={!item.adjacentChunks?.[currentChunk().chunkIndex + 1]}
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

                {/* Actions (dummy — client-only) */}
                <div class="flex items-center gap-1 mt-3 pt-3 border-t border-ed-outline-dim">
                  <DemoActionButton
                    action="like"
                    active={item.actions.includes('like')}
                    icon={<FaRegularHeart class="size-3.5" />}
                    activeIcon={<FaSolidHeart class="size-3.5" />}
                    activeClass="text-ctp-red"
                    title="Like"
                  />
                  <DemoActionButton
                    action="bookmark"
                    active={item.actions.includes('bookmark')}
                    icon={<FaRegularBookmark class="size-3.5" />}
                    activeIcon={<FaSolidBookmark class="size-3.5" />}
                    activeClass="text-ed-primary"
                    title="Bookmark"
                  />
                  <DemoActionButton
                    action="dismiss"
                    active={false}
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
          <p class="font-display text-lg text-ed-on-surface-dim">No demo cards available.</p>
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
