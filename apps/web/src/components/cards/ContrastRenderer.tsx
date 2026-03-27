import { For } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { ContrastContent } from '@scroll-reader/shared-types'

interface Props {
  content: ContrastContent
}

export default function ContrastRenderer(props: Props) {
  return (
    <div class="space-y-4">
      {/* Title */}
      <h3 class="font-display text-xl font-normal text-ed-on-surface flex items-center gap-2 flex-wrap">
        <LatexText text={props.content.itemA} class="inline" /> <span class="font-body text-sm text-ed-on-surface-muted">vs.</span> <LatexText text={props.content.itemB} class="inline" />
      </h3>

      {/* Items with accent borders */}
      <div class="space-y-3">
        <div class="border-l-2 border-ed-primary pl-4 py-1">
          <LatexText text={props.content.itemA} class="font-body text-xs font-semibold italic text-ed-on-surface mb-1" />
          <For each={props.content.dimensions}>
            {(dim, i) => (
              <LatexText
                text={props.content.dimensionA[i()]}
                class="font-body text-sm leading-relaxed text-ed-on-surface-dim"
              />
            )}
          </For>
        </div>

        <div class="border-l-2 border-ed-on-surface-muted pl-4 py-1">
          <LatexText text={props.content.itemB} class="font-body text-xs font-semibold italic text-ed-on-surface mb-1" />
          <For each={props.content.dimensions}>
            {(dim, i) => (
              <LatexText
                text={props.content.dimensionB[i()]}
                class="font-body text-sm leading-relaxed text-ed-on-surface-dim"
              />
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
