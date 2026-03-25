import { createSignal } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { FlashcardContent } from '@scroll-reader/shared-types'

interface Props {
  content: FlashcardContent
}

export default function FlashcardRenderer(props: Props) {
  const [revealed, setRevealed] = createSignal(false)

  return (
    <div class="space-y-2">
      <LatexText text={props.content.question} class="text-sm leading-relaxed text-ctp-text font-medium" />
      {revealed() ? (
        <div class="rounded-lg bg-ctp-surface0 px-3 py-2">
          <LatexText text={props.content.answer} class="text-sm leading-relaxed text-ctp-subtext1" />
        </div>
      ) : (
        <button
          onClick={() => setRevealed(true)}
          class="text-xs text-ctp-peach hover:text-ctp-peach/80 transition-colors"
        >
          Reveal answer
        </button>
      )}
    </div>
  )
}
