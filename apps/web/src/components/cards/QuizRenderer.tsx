import { createSignal, For, Show } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { QuizContent } from '@scroll-reader/shared-types'

interface Props {
  content: QuizContent
}

const OPTION_LABELS = ['A', 'B', 'C', 'D']

export default function QuizRenderer(props: Props) {
  const [selected, setSelected] = createSignal<number | null>(null)

  function select(index: number) {
    if (selected() !== null) return
    setSelected(index)
  }

  return (
    <div class="space-y-5">
      {/* Question — italic serif in quotes */}
      <LatexText text={`"${props.content.question}"`} class="font-display text-xl italic leading-snug text-ed-on-surface" />

      {/* Pill-shaped options */}
      <div class="space-y-2">
        <For each={props.content.options}>
          {(option, i) => {
            const isSelected = () => selected() === i()
            const isCorrect = () => i() === props.content.correct
            const isAnswered = () => selected() !== null

            const style = () => {
              if (!isAnswered()) return 'border-ed-outline hover:border-ed-primary/50 text-ed-on-surface'
              if (isCorrect()) return 'border-ctp-green bg-ctp-green/10 text-ed-on-surface'
              if (isSelected()) return 'border-ctp-red bg-ctp-red/10 text-ed-on-surface'
              return 'border-ed-outline text-ed-on-surface-muted opacity-60'
            }

            return (
              <div>
                <button
                  onClick={() => select(i())}
                  disabled={isAnswered()}
                  class={`flex w-full items-center gap-3 rounded-full border px-4 py-2.5 font-body text-sm transition-colors ${style()}`}
                >
                  <span class="font-semibold text-ed-on-surface-muted">{OPTION_LABELS[i()]}.</span>
                  <LatexText text={option.replace(/^[A-Da-d][).]\s*/, '')} class="inline text-left" />
                </button>
                <Show when={isAnswered() && (isSelected() || isCorrect()) && props.content.explanations?.[i()]}>
                  <LatexText text={props.content.explanations[i()]} class="mt-1.5 ml-4 font-body text-xs text-ed-on-surface-muted leading-relaxed" />
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
