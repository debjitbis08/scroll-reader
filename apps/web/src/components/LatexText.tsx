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

function restoreLatexEscapes(text: string): string {
  // When LaTeX like \times, \beta, \frac is stored in JSON, escape sequences
  // (\t → tab, \b → backspace, \f → form-feed, \n → newline, \r → CR)
  // corrupt the LaTeX. Restore them within math delimiters.
  return text.replace(/\$\$[\s\S]*?\$\$|\$(?:[^$\\]|\\.)*?\$/g, (match) => {
    return match
      .replace(/\x08/g, '\\b')  // backspace → \b (e.g. \beta, \binom)
      .replace(/\t/g, '\\t')    // tab → \t (e.g. \times, \theta)
      .replace(/\n/g, '\\n')    // newline → \n (e.g. \nabla, \nu)
      .replace(/\r/g, '\\r')    // CR → \r (e.g. \rho, \right)
      .replace(/\f/g, '\\f')    // form-feed → \f (e.g. \frac, \forall)
  })
}

function renderLatex(text: string): string {
  // Process display math first ($$...$$), then inline math ($...$)
  let result = restoreLatexEscapes(text)

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

  // Basic markdown: bold, italic, inline code, blockquotes, lists
  result = renderMarkdown(result)

  return result
}

function renderMarkdown(html: string): string {
  // Inline code: `code` → <code>
  html = html.replace(/`([^`]+)`/g, '<code class="rounded bg-ctp-surface1 px-1 py-0.5 text-[0.85em] font-mono">$1</code>')

  // Bold: **text** → <strong>
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')

  // Italic: *text* → <em> (but not inside <strong> tags' asterisks)
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')

  // Process block-level elements within paragraph breaks
  const blocks = html.split(/\n\n+/)
  const rendered = blocks.map((block) => {
    const trimmed = block.trim()
    if (!trimmed) return ''

    // Blockquote: lines starting with >
    if (trimmed.startsWith('&gt; ') || trimmed.startsWith('> ')) {
      const content = trimmed.replace(/^(&gt;|>) /, '')
      return `<blockquote class="border-l-2 border-ctp-surface2 pl-3 italic text-ctp-subtext0">${content}</blockquote>`
    }

    // List block: consecutive lines starting with - or N.
    const lines = trimmed.split('\n')
    const isUnordered = lines.every((l) => l.trimStart().startsWith('- '))
    const isOrdered = lines.every((l) => /^\d+\.\s/.test(l.trimStart()))

    if (isUnordered) {
      const items = lines.map((l) => `<li>${l.trimStart().slice(2)}</li>`).join('')
      return `<ul class="list-disc pl-5 space-y-0.5">${items}</ul>`
    }
    if (isOrdered) {
      const items = lines.map((l) => `<li>${l.trimStart().replace(/^\d+\.\s/, '')}</li>`).join('')
      return `<ol class="list-decimal pl-5 space-y-0.5">${items}</ol>`
    }

    return `<p>${trimmed}</p>`
  })

  return rendered.filter(Boolean).join('')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
