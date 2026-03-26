import { createSignal } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { FlashcardContent } from '@scroll-reader/shared-types'

interface Props {
  content: FlashcardContent
}

export default function FlashcardRenderer(props: Props) {
  const [revealed, setRevealed] = createSignal(false)

  return (
    <div class="flex flex-col items-center text-center py-4 space-y-5">
      {/* Icon */}
      <div class="text-ed-primary">
        <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      {/* Question — italic serif, centered */}
      <p class="font-display text-lg italic leading-snug text-ed-on-surface max-w-sm">
        {props.content.question}
      </p>

      {/* Reveal button or answer */}
      {revealed() ? (
        <div class="rounded bg-ed-surface-container px-4 py-3 w-full max-w-sm">
          <LatexText text={props.content.answer} class="font-body text-sm leading-relaxed text-ed-on-surface-dim" />
        </div>
      ) : (
        <button
          onClick={() => setRevealed(true)}
          class="rounded-full border border-ed-primary px-6 py-2 font-body text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-ed-primary transition-colors hover:bg-ed-primary hover:text-ed-on-primary"
        >
          Reveal Answer
        </button>
      )}
    </div>
  )
}
