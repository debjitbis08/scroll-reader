import { Show } from 'solid-js'
import type { PassageContent } from '@scroll-reader/shared-types'

interface Props {
  content: PassageContent
}

export default function PassageRenderer(props: Props) {
  return (
    <div class="space-y-3">
      {/* Excerpt — serif italic with left accent */}
      <div class="border-l-2 border-ed-primary/40 pl-4">
        <p class="font-display text-base italic leading-relaxed text-ed-on-surface">
          "{props.content.excerpt}"
        </p>
      </div>

      {/* Commentary */}
      <Show when={props.content.commentary}>
        <p class="font-body text-xs leading-relaxed text-ed-on-surface-muted">
          {props.content.commentary}
        </p>
      </Show>
    </div>
  )
}
