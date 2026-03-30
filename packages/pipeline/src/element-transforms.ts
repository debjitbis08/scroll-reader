import type { DocElement, CodeElement, PipelineChunk } from './types.ts'

/**
 * Merge consecutive code elements on the same page into a single element.
 *
 * The PDF extractor often splits a single code block into many tiny elements
 * (individual keywords, grammar rule fragments). This merges them back.
 */
export function mergeConsecutiveCode(elements: DocElement[]): DocElement[] {
  const merged: DocElement[] = []

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el.type === 'code') {
      let combined = el.content
      let j = i + 1
      while (j < elements.length && elements[j].type === 'code' && (elements[j] as CodeElement).chapter === el.chapter) {
        combined += '\n' + (elements[j] as CodeElement).content
        j++
      }
      if (j > i + 1) {
        merged.push({ ...el, content: combined })
        i = j - 1
      } else {
        merged.push(el)
      }
    } else {
      merged.push(el)
    }
  }

  return merged
}

/**
 * Fold small code chunks into adjacent text chunks.
 *
 * Small code fragments (below threshold words) are typically inline examples
 * or grammar rules that only make sense alongside their surrounding text.
 * Merges them into the nearest text chunk so the AI sees them in context.
 */
export function foldSmallCodeIntoText(
  chunks: PipelineChunk[],
  threshold = 50,
): PipelineChunk[] {
  const folded: PipelineChunk[] = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    if (chunk.chunkType === 'code' && chunk.wordCount < threshold) {
      const codeBlock = '\n\n```\n' + chunk.content + '\n```\n\n'

      // Try to attach to preceding text chunk
      if (folded.length > 0 && folded[folded.length - 1].chunkType === 'text') {
        const prev = folded[folded.length - 1]
        prev.content += codeBlock
        prev.wordCount += chunk.wordCount
        prev.images.push(...chunk.images)
      // Try to attach to following text chunk
      } else if (i + 1 < chunks.length && chunks[i + 1].chunkType === 'text') {
        const next = chunks[i + 1]
        next.content = codeBlock + next.content
        next.wordCount += chunk.wordCount
        next.images.push(...chunk.images)
      } else {
        // No adjacent text — keep as-is
        folded.push(chunk)
      }
    } else {
      folded.push(chunk)
    }
  }

  return folded
}
