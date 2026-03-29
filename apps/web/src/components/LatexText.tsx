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

  const isInline = () => props.class?.includes('inline')

  return (
    <div
      class={`${props.class ?? ''}${isInline() ? '' : ' space-y-2'}`}
      innerHTML={rendered()}
    />
  )
}

function restoreLatexEscapes(text: string): string {
  // When LaTeX like \times, \beta, \frac is stored in JSON, escape sequences
  // (\t → tab, \b → backspace, \f → form-feed, \n → newline, \r → CR)
  // corrupt the LaTeX. Restore them within math delimiters — but ONLY when
  // followed by letters that form a known LaTeX command, not when the
  // character is just whitespace before e.g. a variable name like P.
  const nCmds = 'nabla|nu|neg|neq|newline|nleq|ngeq|nmid|notin|not|ni|nolimits|nonumber|norm'
  const tCmds = 'times|theta|tau|text|textbf|textit|textrm|to|top|triangle|tan|tanh|tfrac'
  const bCmds = 'beta|binom|bar|big|Big|bigg|Bigg|bigcap|bigcup|bigvee|bigwedge|bot|boldsymbol|bf'
  const rCmds = 'rho|right|Rightarrow|rightarrow|rangle|rceil|rfloor|rm|root'
  const fCmds = 'frac|forall|flat|frown'

  return text.replace(/\$\$[\s\S]*?\$\$|\$(?:[^$\\]|\\.)*?\$/g, (match) => {
    return match
      .replace(new RegExp(`\\x08(?=${bCmds})`, 'g'), '\\b')
      .replace(new RegExp(`\\t(?=${tCmds})`, 'g'), '\\t')
      .replace(new RegExp(`\\n(?=${nCmds})`, 'g'), '\\n')
      .replace(new RegExp(`\\r(?=${rCmds})`, 'g'), '\\r')
      .replace(new RegExp(`\\f(?=${fCmds})`, 'g'), '\\f')
  })
}

function literalEscapesToNewlines(text: string): string {
  // The JSON parser escapes all backslashes to preserve LaTeX, so \n in the
  // AI output becomes the literal two-char sequence \n (not a real newline).
  // Convert literal \n to actual newlines everywhere, but inside math
  // delimiters protect known LaTeX commands (\nabla, \nu, \theta, etc.)
  // by using a negative lookahead for their command names.
  const nProtect = 'nabla|nu|neg|neq|newline|nleq|ngeq|nmid|notin|not(?![a-z])|ni|nolimits|nonumber|norm'
  const tProtect = 'times|theta|tau|text|textbf|textit|textrm|to(?![a-z])|top|triangle|tan|tanh|tfrac'
  const mathNlReplace = new RegExp(`\\\\n(?!${nProtect})`, 'g')
  const mathTabReplace = new RegExp(`\\\\t(?!${tProtect})`, 'g')

  const mathPattern = /\$\$[\s\S]*?\$\$|\$(?:[^$\\]|\\.)*?\$/g
  let last = 0
  let out = ''
  let m: RegExpExecArray | null
  while ((m = mathPattern.exec(text)) !== null) {
    // Non-math segment: convert all literal \n and \t
    out += text.slice(last, m.index).replace(/\\n/g, '\n').replace(/\\t/g, '\t')
    // Math segment: convert literal \n and \t except before known LaTeX commands
    out += m[0].replace(mathNlReplace, '\n').replace(mathTabReplace, '\t')
    last = m.index + m[0].length
  }
  out += text.slice(last).replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  return out
}

function renderLatex(text: string): string {
  // Convert literal \n to real newlines (outside math), then fix LaTeX escapes inside math
  let result = literalEscapesToNewlines(text)
  result = restoreLatexEscapes(result)

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
  // Fenced code blocks: ```lang\n...\n``` → <pre><code>
  // Must run before inline replacements to avoid mangling code content
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langLabel = lang
      ? `<span class="absolute right-2 top-1.5 text-[0.65rem] text-ctp-subtext0">${escapeHtml(lang)}</span>`
      : ''
    return `<div class="relative my-2 rounded bg-ctp-surface0 text-[0.85em]">${langLabel}<pre class="overflow-x-auto px-3 py-2"><code class="font-mono whitespace-pre">${escapeHtml(code.trim())}</code></pre></div>`
  })

  // Fallback: unfenced code blocks — a bare language name on its own line followed by code.
  // AI sometimes forgets triple backticks and writes e.g. "python\nimport foo\n..."
  // Greedy: captures across blank lines within code, stops at \n\n followed by a prose
  // line (starts with uppercase letter) or end of string.
  const codeLangs = '(?:python|javascript|typescript|java|rust|go|c|cpp|bash|sh|r|sql|ruby|swift|kotlin|scala|html|css)'
  html = html.replace(new RegExp(`(?:^|\\n\\n)${codeLangs}\\n([\\s\\S]+?)(?=\\n\\n[A-Z]|$)`, 'g'), (_match, code) => {
    return `\n\n<div class="relative my-2 rounded bg-ctp-surface0 text-[0.85em]"><pre class="overflow-x-auto px-3 py-2"><code class="font-mono whitespace-pre">${escapeHtml(code.trim())}</code></pre></div>`
  })

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

    // Already rendered as HTML block (e.g. fenced code) — pass through
    if (trimmed.startsWith('<div') || trimmed.startsWith('<pre')) return trimmed

    // Headings: ### h3, ## h2, # h1
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const cls = level === 1 ? 'text-lg font-semibold' : level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold'
      return `<h${level} class="${cls}">${headingMatch[2]}</h${level}>`
    }

    // Blockquote: lines starting with >
    if (trimmed.startsWith('&gt; ') || trimmed.startsWith('> ')) {
      const content = trimmed.replace(/^(&gt;|>) /gm, '')
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
