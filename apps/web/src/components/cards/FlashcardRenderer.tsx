import { createSignal, Show } from 'solid-js'
import { Icon } from '@iconify-icon/solid'
import LatexText from '../LatexText.tsx'
import type { FlashcardContent } from '@scroll-reader/shared-types'

interface Props {
  content: FlashcardContent
  onReveal?: () => void
  onGrade?: (grade: number) => void
}

const GRADE_BUTTONS = [
  { grade: 1, label: "Didn't know", class: 'border-ctp-red/40 text-ctp-red hover:bg-ctp-red/10' },
  { grade: 3, label: 'Kinda', class: 'border-ctp-yellow/40 text-ctp-yellow hover:bg-ctp-yellow/10' },
  { grade: 5, label: 'Got it', class: 'border-ctp-green/40 text-ctp-green hover:bg-ctp-green/10' },
] as const

export default function FlashcardRenderer(props: Props) {
  const [revealed, setRevealed] = createSignal(false)
  const [graded, setGraded] = createSignal(false)

  function reveal() {
    setRevealed(true)
    props.onReveal?.()
  }

  function grade(value: number) {
    if (graded()) return
    setGraded(true)
    props.onGrade?.(value)
  }

  return (
    <div class="flex flex-col items-center text-center py-4 space-y-5">
      <Icon icon="mdi:brain" class="text-ed-primary" width={24} height={24} />

      <LatexText text={props.content.question} class="font-display text-xl italic leading-snug text-ed-on-surface" />

      <Show
        when={revealed()}
        fallback={
          <button
            onClick={reveal}
            class="rounded-full border border-ed-primary px-6 py-2 font-body text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-ed-primary transition-colors hover:bg-ed-primary hover:text-ed-on-primary"
          >
            Reveal Answer
          </button>
        }
      >
        <div class="w-full space-y-4 animate-fade-in">
          <div class="rounded bg-ed-surface-container px-4 py-3">
            <LatexText text={props.content.answer} class="font-body text-sm leading-relaxed text-ed-on-surface-dim" />
          </div>

          <Show
            when={!graded()}
            fallback={
              <p class="font-body text-[0.6rem] uppercase tracking-[0.15em] text-ed-on-surface-muted">Graded</p>
            }
          >
            <div class="flex items-center justify-center gap-2">
              {GRADE_BUTTONS.map((btn) => (
                <button
                  onClick={() => grade(btn.grade)}
                  class={`rounded-full border px-4 py-1.5 font-body text-[0.6rem] font-semibold uppercase tracking-[0.1em] transition-colors ${btn.class}`}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
