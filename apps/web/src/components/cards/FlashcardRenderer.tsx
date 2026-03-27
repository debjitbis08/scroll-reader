import { createSignal, Show } from 'solid-js'
import { Icon } from '@iconify-icon/solid'
import LatexText from '../LatexText.tsx'
import type { FlashcardContent } from '@scroll-reader/shared-types'

interface Props {
  content: FlashcardContent
}

export default function FlashcardRenderer(props: Props) {
  const [revealed, setRevealed] = createSignal(false)

  return (
    <div class="flex flex-col items-center text-center py-4 space-y-5">
      <Icon icon="mdi:brain" class="text-ed-primary" width={24} height={24} />

      <LatexText text={props.content.question} class="font-display text-xl italic leading-snug text-ed-on-surface" />

      <Show
        when={revealed()}
        fallback={
          <button
            onClick={() => setRevealed(true)}
            class="rounded-full border border-ed-primary px-6 py-2 font-body text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-ed-primary transition-colors hover:bg-ed-primary hover:text-ed-on-primary"
          >
            Reveal Answer
          </button>
        }
      >
        <div class="w-full space-y-3 animate-fade-in">
          <div class="rounded bg-ed-surface-container px-4 py-3">
            <LatexText text={props.content.answer} class="font-body text-sm leading-relaxed text-ed-on-surface-dim" />
          </div>
          <button
            onClick={() => setRevealed(false)}
            class="font-body text-[0.6rem] uppercase tracking-[0.15em] text-ed-on-surface-muted hover:text-ed-on-surface-dim transition-colors"
          >
            Hide Answer
          </button>
        </div>
      </Show>
    </div>
  )
}
