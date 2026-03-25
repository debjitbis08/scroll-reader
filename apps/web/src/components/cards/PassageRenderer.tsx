import { Show } from 'solid-js'
import LatexText from '../LatexText.tsx'
import type { PassageContent } from '@scroll-reader/shared-types'

interface Props {
  content: PassageContent
}

export default function PassageRenderer(props: Props) {
  return (
    <div class="space-y-3">
      <div class="relative pl-4 border-l-2 border-ctp-flamingo/40">
        <span class="absolute -left-2 -top-2 text-3xl text-ctp-flamingo/30 font-serif leading-none select-none">"</span>
        <p class="text-sm leading-relaxed text-ctp-text italic font-serif pt-2">
          {props.content.excerpt}
        </p>
      </div>

      <Show when={props.content.commentary}>
        <p class="text-xs text-ctp-subtext0 leading-relaxed">
          {props.content.commentary}
        </p>
      </Show>
    </div>
  )
}
