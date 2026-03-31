import { describe, it, expect } from 'vitest'
import { classifyToc, classifyTocHeuristic } from './classify-toc.ts'
import type { TocSection } from './classify-toc.ts'
import type { AIProvider, AIResponse, TocEntry } from './types.ts'

// ── Helpers ──

function makeToc(titles: string[]): TocEntry[] {
  return titles.map((title, i) => ({ title, page: i + 1, level: 0 }))
}

function fakeProvider(text: string): AIProvider {
  return {
    name: 'gemini',
    model: 'test',
    async generate(): Promise<AIResponse> {
      return { text, usage: null }
    },
  }
}

// ── Heuristic tests ──

describe('classifyTocHeuristic', () => {
  it('classifies a typical book TOC', () => {
    const toc = makeToc([
      'Title Page',
      'Copyright',
      'Dedication',
      'Foreword',
      'Chapter 1: The Beginning',
      'Chapter 2: The Middle',
      'Chapter 3: The End',
      'Appendix A',
      'Bibliography',
      'Index',
    ])
    expect(classifyTocHeuristic(toc)).toEqual([
      'front', 'front', 'front', 'front',
      'main', 'main', 'main',
      'back', 'back', 'back',
    ])
  })

  it('classifies all main when no front/back markers', () => {
    const toc = makeToc(['Chapter 1', 'Chapter 2', 'Chapter 3'])
    expect(classifyTocHeuristic(toc)).toEqual(['main', 'main', 'main'])
  })

  it('does not classify mid-book entries as front matter', () => {
    const toc = makeToc([
      'Preface',
      'Chapter 1',
      'Acknowledgments',  // after main has started — should stay main
      'Chapter 2',
    ])
    // "Acknowledgments" after main content should NOT be front
    const result = classifyTocHeuristic(toc)
    expect(result[0]).toBe('front')
    expect(result[1]).toBe('main')
    expect(result[2]).toBe('main') // not 'front' — seenMain is true
    expect(result[3]).toBe('main')
  })

  it('detects back matter after main', () => {
    const toc = makeToc([
      'Introduction',
      'Part I',
      'Glossary',
      'About the Author',
    ])
    const result = classifyTocHeuristic(toc)
    expect(result).toEqual(['main', 'main', 'back', 'back'])
  })

  it('inherits back matter for nested children of a back matter entry', () => {
    const toc: TocEntry[] = [
      { title: 'Chapter 1', page: 1, level: 0 },
      { title: 'Chapter 2', page: 10, level: 0 },
      { title: 'Appendix A', page: 20, level: 0 },
      { title: 'Data Tables', page: 21, level: 1 },
      { title: 'Supplementary Figures', page: 25, level: 1 },
      { title: 'Appendix B', page: 30, level: 0 },
      { title: 'Methodology Notes', page: 31, level: 1 },
    ]
    expect(classifyTocHeuristic(toc)).toEqual([
      'main', 'main', 'back', 'back', 'back', 'back', 'back',
    ])
  })

  it('inherits front matter for nested children of a front matter entry', () => {
    const toc: TocEntry[] = [
      { title: 'Foreword', page: 1, level: 0 },
      { title: 'By John Smith', page: 1, level: 1 },
      { title: 'Chapter 1', page: 5, level: 0 },
    ]
    expect(classifyTocHeuristic(toc)).toEqual(['front', 'front', 'main'])
  })

  it('does not inherit back matter to sibling entries at the same level', () => {
    const toc: TocEntry[] = [
      { title: 'Chapter 1', page: 1, level: 0 },
      { title: 'Glossary', page: 10, level: 0 },
      { title: 'Terms A-M', page: 11, level: 1 },
      { title: 'Terms N-Z', page: 15, level: 1 },
      { title: 'Chapter 2', page: 20, level: 0 },  // same level as Glossary — not nested
    ]
    const result = classifyTocHeuristic(toc)
    expect(result[0]).toBe('main')
    expect(result[1]).toBe('back')
    expect(result[2]).toBe('back')
    expect(result[3]).toBe('back')
    expect(result[4]).toBe('main')  // sibling, not child of Glossary
  })

  it('handles deeply nested back matter', () => {
    const toc: TocEntry[] = [
      { title: 'Chapter 1', page: 1, level: 0 },
      { title: 'Appendix', page: 10, level: 0 },
      { title: 'Section A', page: 11, level: 1 },
      { title: 'Subsection A.1', page: 12, level: 2 },
      { title: 'Detail A.1.1', page: 13, level: 3 },
    ]
    expect(classifyTocHeuristic(toc)).toEqual([
      'main', 'back', 'back', 'back', 'back',
    ])
  })

  it('handles empty TOC', () => {
    expect(classifyTocHeuristic([])).toEqual([])
  })
})

// ── AI integration tests (with mock provider) ──

describe('classifyToc', () => {
  it('parses clean JSON response', async () => {
    const toc = makeToc(['Preface', 'Chapter 1', 'Index'])
    const provider = fakeProvider('["front","main","back"]')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(['front', 'main', 'back'])
  })

  it('strips ```json fences from response', async () => {
    const toc = makeToc(['Preface', 'Chapter 1', 'Index'])
    const provider = fakeProvider('```json\n["front","main","back"]\n```')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(['front', 'main', 'back'])
  })

  it('strips ``` fences without language tag', async () => {
    const toc = makeToc(['Preface', 'Chapter 1'])
    const provider = fakeProvider('```\n["front","main"]\n```')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(['front', 'main'])
  })

  it('falls back to heuristic when array length mismatches', async () => {
    const toc = makeToc(['Preface', 'Chapter 1', 'Index'])
    // AI returns only 2 entries instead of 3
    const provider = fakeProvider('["front","main"]')
    const { classification } = await classifyToc(toc, provider)
    // Should get heuristic result instead
    expect(classification).toEqual(classifyTocHeuristic(toc))
  })

  it('falls back to heuristic when values are invalid', async () => {
    const toc = makeToc(['Preface', 'Chapter 1'])
    const provider = fakeProvider('["front","middle"]') // "middle" is not valid
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(classifyTocHeuristic(toc))
  })

  it('falls back to heuristic when response is not JSON', async () => {
    const toc = makeToc(['Preface', 'Chapter 1'])
    const provider = fakeProvider('I think the first entry is front matter and the second is main.')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(classifyTocHeuristic(toc))
  })

  it('falls back to heuristic when provider throws', async () => {
    const toc = makeToc(['Preface', 'Chapter 1'])
    const provider: AIProvider = {
      name: 'gemini',
      model: 'test',
      async generate() { throw new Error('network error') },
    }
    const { classification, usage } = await classifyToc(toc, provider)
    expect(classification).toEqual(classifyTocHeuristic(toc))
    expect(usage).toBeNull()
  })

  it('returns empty for empty TOC', async () => {
    const provider = fakeProvider('[]')
    const { classification } = await classifyToc([], provider)
    expect(classification).toEqual([])
  })

  it('handles response with leading/trailing whitespace', async () => {
    const toc = makeToc(['Copyright', 'Chapter 1'])
    const provider = fakeProvider('  \n ["front","main"] \n ')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(['front', 'main'])
  })

  it('handles nested code fences with extra whitespace', async () => {
    const toc = makeToc(['Dedication', 'Part One', 'Appendix'])
    const provider = fakeProvider('```json\n\n["front","main","back"]\n\n```\n')
    const { classification } = await classifyToc(toc, provider)
    expect(classification).toEqual(['front', 'main', 'back'])
  })
})
