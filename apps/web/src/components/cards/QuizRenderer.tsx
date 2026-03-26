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
    <div class="space-y-3">
      <LatexText text={props.content.question} class="text-sm leading-relaxed text-ctp-text font-medium" />

      <div class="space-y-2">
        <For each={props.content.options}>
          {(option, i) => {
            const isSelected = () => selected() === i()
            const isCorrect = () => i() === props.content.correct
            const isAnswered = () => selected() !== null

            const borderColor = () => {
              if (!isAnswered()) return 'border-ctp-surface2 hover:border-ctp-mauve/50'
              if (isCorrect()) return 'border-ctp-green bg-ctp-green/10'
              if (isSelected()) return 'border-ctp-red bg-ctp-red/10'
              return 'border-ctp-surface2 opacity-60'
            }

            return (
              <button
                onClick={() => select(i())}
                disabled={isAnswered()}
                class={`flex gap-2 w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors ${borderColor()}`}
              >
                <span class="font-medium text-ctp-subtext0">{OPTION_LABELS[i()]}.</span>
                <LatexText text={option.replace(/^[A-Da-d][).]\s*/, '')} class="inline text-ctp-text" />
                <Show when={isAnswered() && (isSelected() || isCorrect()) && props.content.explanations?.[i()]}>
                  <p class="mt-1.5 text-xs text-ctp-subtext0 leading-relaxed">
                    {props.content.explanations[i()]}
                  </p>
                </Show>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
