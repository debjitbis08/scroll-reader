import { For } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { ContrastContent } from '@scroll-reader/shared-types'

interface Props {
  content: ContrastContent
}

export default function ContrastRenderer(props: Props) {
  return (
    <div class="space-y-2">
      {/* Header: A vs B */}
      <div class="flex items-center gap-2 text-sm font-semibold">
        <span class="text-ctp-teal">{props.content.itemA}</span>
        <span class="text-ctp-subtext0 text-xs">vs</span>
        <span class="text-ctp-teal">{props.content.itemB}</span>
      </div>

      {/* Dimension rows */}
      <div class="space-y-1.5">
        <For each={props.content.dimensions}>
          {(dim, i) => (
            <div class="rounded-lg bg-ctp-surface0 px-3 py-2">
              <p class="text-xs font-medium text-ctp-subtext0 mb-1">{dim}</p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <LatexText
                  text={props.content.dimensionA[i()]}
                  class="text-xs leading-relaxed text-ctp-text"
                />
                <LatexText
                  text={props.content.dimensionB[i()]}
                  class="text-xs leading-relaxed text-ctp-subtext1"
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
