import type { CardContent } from '@scroll-reader/shared-types'

export interface TestCard {
  cardType: string
  content: CardContent
  chunkIndex: number
  chunk: {
    content: string
    chapter: string | null
    images: { file: string; alt: string; mime: string }[]
  }
}
