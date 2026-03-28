import { createSignal, For, Show } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { QuizContent } from '@scroll-reader/shared-types'

interface Props {
  content: QuizContent
  onAnswer?: (selectedIndex: number) => void
}

const OPTION_LABELS = ['A', 'B', 'C', 'D']

export default function QuizRenderer(props: Props) {
  const [selected, setSelected] = createSignal<number | null>(null)

  // Shuffled order of original indices, stable for the lifetime of this component
  const shuffledIndices = [...Array(props.content.options.length).keys()]
  for (let i = shuffledIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]]
  }

  function select(originalIndex: number) {
    if (selected() !== null) return
    setSelected(originalIndex)
    props.onAnswer?.(originalIndex)
  }

  return (
    <div class="space-y-5">
      {/* Question — italic serif in quotes */}
      <LatexText text={`"${props.content.question}"`} class="font-display text-xl italic leading-snug text-ed-on-surface" />

      {/* Pill-shaped options */}
      <div class="space-y-2">
        <For each={shuffledIndices}>
          {(originalIndex, displayIndex) => {
            const option = props.content.options[originalIndex]
            const isSelected = () => selected() === originalIndex
            const isCorrect = () => originalIndex === props.content.correct
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
                  onClick={() => select(originalIndex)}
                  disabled={isAnswered()}
                  class={`flex w-full items-center gap-3 rounded-full border px-4 py-2.5 font-body text-sm transition-colors ${style()}`}
                >
                  <span class="font-semibold text-ed-on-surface-muted">{OPTION_LABELS[displayIndex()]}.</span>
                  <LatexText text={option.replace(/^[A-Da-d][).]\s*/, '')} class="inline text-left" />
                </button>
                <Show when={isAnswered() && (isSelected() || isCorrect()) && props.content.explanations?.[originalIndex]}>
                  <LatexText text={props.content.explanations[originalIndex].replace(/^[A-Da-d][).]\s*/, '')} class="mt-1.5 ml-4 font-body text-xs text-ed-on-surface-muted leading-relaxed" />
                </Show>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
