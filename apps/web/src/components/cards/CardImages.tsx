import { For, Show } from 'solid-js'

interface Props {
  /** 0-based indices into chunkImageUrls */
  indices: number[]
  /** Signed URLs for chunk images, ordered by position */
  chunkImageUrls: { url: string; alt: string }[]
}

export default function CardImages(props: Props) {
  const images = () =>
    props.indices
      .filter((i) => i >= 0 && i < props.chunkImageUrls.length)
      .map((i) => props.chunkImageUrls[i])

  return (
    <Show when={images().length > 0}>
      <div class="mt-3 flex flex-wrap gap-2">
        <For each={images()}>
          {(img) => (
            <img
              src={img.url}
              alt={img.alt}
              loading="lazy"
              class="max-h-64 max-w-full rounded-lg border border-ed-outline"
            />
          )}
        </For>
      </div>
    </Show>
  )
}
