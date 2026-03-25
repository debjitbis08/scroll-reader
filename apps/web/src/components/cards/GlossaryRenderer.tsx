import { Show, For } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { GlossaryContent } from '@scroll-reader/shared-types'

interface Props {
  content: GlossaryContent
}

export default function GlossaryRenderer(props: Props) {
  return (
    <div class="space-y-2">
      <LatexText text={props.content.term} class="text-base font-bold text-ctp-text" />
      <LatexText text={props.content.definition} class="text-sm leading-relaxed text-ctp-text" />

      <Show when={props.content.etymology}>
        <p class="text-xs italic text-ctp-subtext0">
          Origin: {props.content.etymology}
        </p>
      </Show>

      <Show when={props.content.related && props.content.related.length > 0}>
        <div class="flex flex-wrap gap-1.5 pt-1">
          <For each={props.content.related}>
            {(term) => (
              <span class="rounded-full bg-ctp-surface1 px-2 py-0.5 text-xs text-ctp-subtext1">
                {term}
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
