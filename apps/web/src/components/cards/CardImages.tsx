import { createSignal, For, Show } from 'solid-js'
import ImageModal from '../ImageModal'

interface Props {
  /** 0-based indices into chunkImageUrls */
  indices: number[]
  /** Signed URLs for chunk images, ordered by position */
  chunkImageUrls: { url: string; alt: string }[]
}

export default function CardImages(props: Props) {
  const [modalImage, setModalImage] = createSignal<{ url: string; alt: string } | null>(null)

  const images = () =>
    props.indices
      .filter((i) => i >= 0 && i < props.chunkImageUrls.length)
      .map((i) => props.chunkImageUrls[i])

  function handleLoad(e: Event) {
    const img = e.target as HTMLImageElement
    if (img.naturalWidth < 40 || img.naturalHeight < 40) {
      img.style.display = 'none'
    }
  }

  return (
    <Show when={images().length > 0}>
      <div class="mt-3 space-y-2">
        <For each={images()}>
          {(img) => (
            <img
              src={img.url}
              alt={img.alt}
              loading="lazy"
              onLoad={handleLoad}
              onClick={() => setModalImage(img)}
              class="max-w-full cursor-zoom-in rounded-lg border border-ed-outline"
            />
          )}
        </For>
      </div>

      <ImageModal
        src={modalImage()?.url ?? ''}
        alt={modalImage()?.alt ?? ''}
        open={modalImage() !== null}
        onClose={() => setModalImage(null)}
      />
    </Show>
  )
}
