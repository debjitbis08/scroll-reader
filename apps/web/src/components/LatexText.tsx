import { createMemo } from 'solid-js'
import katex from 'katex'

interface Props {
  text: string
  class?: string
}

/**
 * Renders text with inline LaTeX math expressions.
 * Supports both $...$ (inline) and $$...$$ (display) delimiters.
 */
export default function LatexText(props: Props) {
  const rendered = createMemo(() => renderLatex(props.text))

  return (
    <p class={props.class} innerHTML={rendered()} />
  )
}

function renderLatex(text: string): string {
  // Process display math first ($$...$$), then inline math ($...$)
  let result = text

  // Display math: $$...$$
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false })
    } catch {
      return `<span class="text-ctp-red">${escapeHtml(tex)}</span>`
    }
  })

  // Inline math: $...$
  // Avoid matching escaped dollars or empty delimiters
  result = result.replace(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$/g, (_match, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false })
    } catch {
      return `<span class="text-ctp-red">${escapeHtml(tex)}</span>`
    }
  })

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
