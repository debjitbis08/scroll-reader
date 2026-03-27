import { Show, For } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { GlossaryContent } from '@scroll-reader/shared-types'

interface Props {
  content: GlossaryContent
}

export default function GlossaryRenderer(props: Props) {
  return (
    <div class="space-y-3">
      {/* Term — large serif */}
      <h3 class="font-display text-2xl font-normal text-ed-on-surface">
        <LatexText text={props.content.term} />
      </h3>

      {/* Definition */}
      <LatexText text={props.content.definition} class="font-body text-sm leading-relaxed text-ed-on-surface-dim" />

      {/* Etymology */}
      <Show when={props.content.etymology}>
        <p class="font-body text-xs italic text-ed-on-surface-muted">
          Origin: {props.content.etymology}
        </p>
      </Show>

      {/* Related terms as chips */}
      <Show when={props.content.related && props.content.related.length > 0}>
        <div class="flex flex-wrap gap-1.5 pt-1">
          <For each={props.content.related}>
            {(term) => (
              <span class="rounded bg-ed-surface-highest px-2.5 py-1 font-body text-[0.65rem] uppercase tracking-wider text-ed-on-surface-muted">
                {term}
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
