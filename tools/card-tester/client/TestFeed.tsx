import { createSignal, onMount, For, Show, Switch, Match } from 'solid-js'
import LatexText from '@web/components/LatexText.tsx'
import FlashcardRenderer from '@web/components/cards/FlashcardRenderer.tsx'
import QuizRenderer from '@web/components/cards/QuizRenderer.tsx'
import GlossaryRenderer from '@web/components/cards/GlossaryRenderer.tsx'
import ContrastRenderer from '@web/components/cards/ContrastRenderer.tsx'
import PassageRenderer from '@web/components/cards/PassageRenderer.tsx'
import CardImages from '@web/components/cards/CardImages.tsx'
import type {
  BodyContent,
  FlashcardContent,
  QuizContent,
  GlossaryContent,
  ContrastContent,
  PassageContent,
} from '@scroll-reader/shared-types'
import type { TestCard } from './types.ts'

const CARD_TYPE_LABEL: Record<string, string> = {
  discover: 'Discovery',
  raw_commentary: 'Notes',
  flashcard: 'Active Recall',
  quiz: 'Quiz',
  glossary: 'Glossary',
  contrast: 'Contrast',
  passage: 'Passage',
  connect: 'Connect',
}

export default function TestFeed() {
  const [cards, setCards] = createSignal<TestCard[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const res = await fetch('/api/cards')
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`)
      setCards(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cards')
    } finally {
      setLoading(false)
    }
  })

  function stats() {
    const counts: Record<string, number> = {}
    for (const c of cards()) counts[c.cardType] = (counts[c.cardType] ?? 0) + 1
    return Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(' \u00b7 ')
  }

  return (
    <div class="mx-auto max-w-[640px] px-4 py-6">
      <h1 class="font-display text-2xl text-ed-primary mb-2">Card Tester</h1>

      <Show when={!loading()} fallback={
        <div class="flex justify-center py-20">
          <div class="size-6 animate-spin rounded-full border-2 border-ed-outline border-t-ed-primary" />
        </div>
      }>
        <Show when={error()}>
          <div class="rounded bg-ctp-red/10 px-6 py-4 font-body text-sm text-ctp-red">
            {error()}
            <br /><br />Run "extract" and "generate" first.
          </div>
        </Show>

        <Show when={cards().length > 0}>
          <p class="font-body text-sm text-ed-on-surface-muted mb-6 pb-4 border-b border-ed-outline-dim">
            {cards().length} cards &middot; {stats()}
          </p>

          <div class="flex flex-col gap-10">
            <For each={cards()}>
              {(item) => <CardItem item={item} />}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function CardItem(props: { item: TestCard }) {
  const chunkImageUrls = () =>
    props.item.chunk.images.map((img) => ({
      url: `/${img.file}`,
      alt: img.alt,
    }))

  return (
    <div>
      {/* Card type label */}
      <div class="mb-2">
        <span class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
          {CARD_TYPE_LABEL[props.item.cardType] ?? props.item.cardType}
        </span>
      </div>

      {/* Card box */}
      <div class={`rounded p-6 ${props.item.cardType === 'flashcard' ? 'bg-ed-surface-dim' : 'bg-ed-surface-high'}`}>
        <div>
          <Switch fallback={
            <LatexText
              text={(props.item.content as BodyContent).body ?? ''}
              class="font-display text-[0.95rem] leading-relaxed text-ed-on-surface"
            />
          }>
            <Match when={props.item.cardType === 'discover'}>
              <div class="space-y-3">
                <Show when={(props.item.content as BodyContent).title}>
                  <h3 class="font-display text-xl leading-snug text-ed-on-surface">
                    {(props.item.content as BodyContent).title}
                  </h3>
                </Show>
                <LatexText
                  text={(props.item.content as BodyContent).body ?? ''}
                  class="font-body text-sm leading-relaxed text-ed-on-surface-dim"
                />
              </div>
            </Match>
            <Match when={props.item.cardType === 'flashcard'}>
              <FlashcardRenderer content={props.item.content as FlashcardContent} />
            </Match>
            <Match when={props.item.cardType === 'quiz'}>
              <QuizRenderer content={props.item.content as QuizContent} />
            </Match>
            <Match when={props.item.cardType === 'glossary'}>
              <GlossaryRenderer content={props.item.content as GlossaryContent} />
            </Match>
            <Match when={props.item.cardType === 'contrast'}>
              <ContrastRenderer content={props.item.content as ContrastContent} />
            </Match>
            <Match when={props.item.cardType === 'passage'}>
              <PassageRenderer content={props.item.content as PassageContent} />
            </Match>
          </Switch>

          {/* Card images */}
          <Show when={
            Array.isArray((props.item.content as Record<string, unknown>).images) &&
            ((props.item.content as Record<string, unknown>).images as number[]).length > 0 &&
            chunkImageUrls().length > 0
          }>
            <CardImages
              indices={(props.item.content as Record<string, unknown>).images as number[]}
              chunkImageUrls={chunkImageUrls()}
            />
          </Show>
        </div>

        {/* Source chunk toggle */}
        <SourceToggle item={props.item} chunkImageUrls={chunkImageUrls()} />
      </div>
    </div>
  )
}

function SourceToggle(props: { item: TestCard; chunkImageUrls: { url: string; alt: string }[] }) {
  const [open, setOpen] = createSignal(false)

  return (
    <div class="mt-3 pt-3 border-t border-ed-outline-dim">
      <button
        onClick={() => setOpen(!open())}
        class="font-body text-[0.65rem] text-ed-on-surface-muted hover:text-ed-on-surface-dim transition-colors"
      >
        source {open() ? '\u2191' : '\u2193'}
      </button>
      <Show when={open()}>
        <div class="mt-2 space-y-2">
          <div class="font-body text-[0.65rem] text-ed-on-surface-muted">
            Chunk #{props.item.chunkIndex}
            {props.item.chunk.chapter && ` \u00b7 ${props.item.chunk.chapter}`}
          </div>
          <div class="max-h-64 overflow-y-auto rounded bg-ed-surface-container px-3 py-2 font-body text-xs leading-relaxed text-ed-on-surface-dim whitespace-pre-line text-justify">
            {props.item.chunk.content}
          </div>
          <Show when={props.item.chunk.images.length > 0}>
            <div class="flex flex-wrap gap-2">
              <For each={props.item.chunk.images}>
                {(img) => (
                  <img
                    src={`/${img.file}`}
                    alt={img.alt}
                    loading="lazy"
                    class="max-h-48 max-w-full rounded border border-ed-outline"
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
