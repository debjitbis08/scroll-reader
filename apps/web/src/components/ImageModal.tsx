import { createSignal, Show, onCleanup } from 'solid-js'

interface Props {
  src: string
  alt: string
  open: boolean
  onClose: () => void
}

export default function ImageModal(props: Props) {
  let imgRef!: HTMLImageElement
  let containerRef!: HTMLDivElement

  const [scale, setScale] = createSignal(1)
  const [translate, setTranslate] = createSignal({ x: 0, y: 0 })

  // Pinch-to-zoom state
  let initialPinchDistance = 0
  let initialScale = 1
  let lastTouchCount = 0

  // Pan state
  let isPanning = false
  let panStart = { x: 0, y: 0 }
  let translateStart = { x: 0, y: 0 }

  function reset() {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }

  function handleClose() {
    reset()
    props.onClose()
  }

  function getTouchDistance(t1: Touch, t2: Touch) {
    const dx = t1.clientX - t2.clientX
    const dy = t1.clientY - t2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      e.preventDefault()
      initialPinchDistance = getTouchDistance(e.touches[0], e.touches[1])
      initialScale = scale()
      lastTouchCount = 2
    } else if (e.touches.length === 1 && scale() > 1) {
      // Start panning when zoomed in
      isPanning = true
      panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      translateStart = { ...translate() }
    }
  }

  function handleTouchMove(e: TouchEvent) {
    if (e.touches.length === 2) {
      e.preventDefault()
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1])
      const newScale = Math.min(Math.max(initialScale * (currentDistance / initialPinchDistance), 1), 5)
      setScale(newScale)
      if (newScale === 1) setTranslate({ x: 0, y: 0 })
    } else if (e.touches.length === 1 && isPanning && scale() > 1) {
      e.preventDefault()
      const dx = e.touches[0].clientX - panStart.x
      const dy = e.touches[0].clientY - panStart.y
      setTranslate({ x: translateStart.x + dx, y: translateStart.y + dy })
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) {
      lastTouchCount = e.touches.length
    }
    if (e.touches.length === 0) {
      isPanning = false
    }
  }

  // Double-tap to zoom/reset
  let lastTap = 0
  function handleTap(e: TouchEvent) {
    if (e.touches.length !== 1) return
    const now = Date.now()
    if (now - lastTap < 300) {
      e.preventDefault()
      if (scale() > 1) {
        reset()
      } else {
        setScale(2.5)
      }
    }
    lastTap = now
  }

  // Mouse wheel zoom for desktop
  function handleWheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.2 : 0.2
    const newScale = Math.min(Math.max(scale() + delta, 1), 5)
    setScale(newScale)
    if (newScale === 1) setTranslate({ x: 0, y: 0 })
  }

  // Close on Escape
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleClose()
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/80"
        onClick={handleClose}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        ref={(el) => setTimeout(() => el.focus(), 0)}
      >
        {/* Close button */}
        <button
          class="absolute right-4 top-4 z-[71] rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          onClick={(e) => { e.stopPropagation(); handleClose() }}
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Image container */}
        <div
          ref={containerRef!}
          class="flex h-[90vh] w-[95vw] items-center justify-center overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => { handleTap(e); handleTouchStart(e) }}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onWheel={handleWheel}
          style={{ "touch-action": "none" }}
        >
          <img
            ref={imgRef!}
            src={props.src}
            alt={props.alt}
            class="h-full w-full select-none object-contain"
            draggable={false}
            style={{
              transform: `scale(${scale()}) translate(${translate().x / scale()}px, ${translate().y / scale()}px)`,
              "transition": scale() === 1 ? "transform 0.2s ease" : "none",
            }}
          />
        </div>
      </div>
    </Show>
  )
}
