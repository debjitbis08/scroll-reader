import { createSignal, Show } from 'solid-js'
import { FiSearch } from 'solid-icons/fi'

export default function SearchModal() {
  const [open, setOpen] = createSignal(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-search-trigger
        class="hidden"
        aria-hidden="true"
      />

      <Show when={open()}>
        <div
          class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={() => setOpen(false)}
        >
          <div
            class="mx-4 w-full max-w-sm rounded-lg bg-ed-surface-high p-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <FiSearch class="mx-auto mb-3 size-8 text-ed-primary" />
            <h3 class="font-display text-lg text-ed-on-surface">Search</h3>
            <p class="mt-2 font-body text-sm text-ed-on-surface-dim">
              Coming soon! You'll be able to search across all your cards and documents.
            </p>
            <button
              onClick={() => setOpen(false)}
              class="mt-4 rounded bg-ed-primary px-4 py-2 font-body text-sm font-medium text-ed-on-primary transition-colors hover:bg-ed-primary/80"
            >
              Got it
            </button>
          </div>
        </div>
      </Show>
    </>
  )
}
