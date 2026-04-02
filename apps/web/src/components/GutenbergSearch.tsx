import { createSignal, For, Show } from "solid-js";
import CatalogConfigModal from "./CatalogConfigModal.tsx";

interface SearchResult {
  gutenbergId: number;
  title: string;
  author: string | null;
  subjects: string[];
  bookshelves: string[];
  coverUrl: string | null;
  epubUrl: string | null;
  cacheStatus: string | null; // null | 'ready' | 'pending' | 'chunking' | 'generating'
}

export default function GutenbergSearch() {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [hasMore, setHasMore] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const [totalCount, setTotalCount] = createSignal(0);

  // Modal state
  const [selectedBook, setSelectedBook] = createSignal<SearchResult | null>(
    null,
  );

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  async function search(loadMore = false) {
    const q = query().trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    const currentOffset = loadMore ? offset() : 0;
    if (!loadMore) {
      setResults([]);
      setOffset(0);
      setSearched(true);
    }

    try {
      const res = await fetch(
        `/api/gutenberg/search?q=${encodeURIComponent(q)}&limit=20&offset=${currentOffset}`,
      );
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      if (loadMore) {
        setResults((prev) => [...prev, ...data.results]);
      } else {
        setResults(data.results);
      }
      setOffset(currentOffset + data.results.length);
      setHasMore(data.hasMore);
      setTotalCount(data.count);
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function onInput(value: string) {
    setQuery(value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (value.trim().length >= 2) search(false);
    }, 400);
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    clearTimeout(debounceTimer);
    search(false);
  }

  return (
    <div class="space-y-6">
      {/* Search bar */}
      <form onSubmit={onSubmit} class="flex gap-2">
        <input
          type="text"
          value={query()}
          onInput={(e) => onInput(e.currentTarget.value)}
          placeholder="Search by title or author..."
          class="flex-1 rounded bg-ed-surface-high px-4 py-2.5 font-body text-sm text-ed-on-surface placeholder:text-ed-on-surface-muted outline-none focus:ring-1 focus:ring-ed-primary transition-shadow"
        />
        <button
          type="submit"
          disabled={loading() || query().trim().length < 2}
          class="rounded bg-ed-primary px-5 py-2.5 font-body text-sm font-medium text-ed-on-primary transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
        >
          Search
        </button>
      </form>

      <Show when={error()}>
        <p class="font-body text-sm text-ctp-red">{error()}</p>
      </Show>

      {/* Results */}
      <Show when={results().length > 0}>
        <p class="font-body text-xs text-ed-on-surface-muted">
          {totalCount()} results
        </p>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <For each={results()}>
            {(book) => (
              <button
                type="button"
                onClick={() => setSelectedBook(book)}
                disabled={!book.epubUrl}
                class="flex gap-3 rounded bg-ed-surface-high p-4 text-left transition-colors hover:bg-ed-surface-highest disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {/* Cover */}
                <div class="w-14 shrink-0">
                  <Show
                    when={book.coverUrl}
                    fallback={
                      <div class="flex h-20 w-14 items-center justify-center rounded bg-ed-surface-container">
                        <svg
                          class="size-6 text-ed-on-surface-muted"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                        >
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                        </svg>
                      </div>
                    }
                  >
                    <img
                      src={book.coverUrl!}
                      alt={book.title}
                      class="h-20 w-14 rounded object-cover"
                      loading="lazy"
                    />
                  </Show>
                </div>

                {/* Info */}
                <div class="flex-1 min-w-0 space-y-1">
                  <p class="font-body text-sm font-medium text-ed-on-surface truncate">
                    {book.title}
                  </p>
                  <Show when={book.author}>
                    <p class="font-body text-xs text-ed-on-surface-muted truncate">
                      {book.author}
                    </p>
                  </Show>
                  <div class="flex items-center gap-2">
                    <Show when={book.cacheStatus === "ready"}>
                      <span class="rounded-full bg-ed-primary-container px-2 py-0.5 font-body text-[0.6rem] font-semibold text-ed-primary">
                        Instant
                      </span>
                    </Show>
                    <Show
                      when={
                        book.cacheStatus &&
                        book.cacheStatus !== "ready" &&
                        book.cacheStatus !== "error"
                      }
                    >
                      <span class="rounded-full bg-ed-surface-container px-2 py-0.5 font-body text-[0.6rem] text-ed-on-surface-muted">
                        Processing...
                      </span>
                    </Show>
                    <Show when={!book.epubUrl}>
                      <span class="font-body text-[0.6rem] text-ed-on-surface-muted">
                        No EPUB available
                      </span>
                    </Show>
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Load more */}
      <Show when={hasMore()}>
        <div class="flex justify-center">
          <button
            type="button"
            onClick={() => search(true)}
            disabled={loading()}
            class="rounded bg-ed-surface-high px-5 py-2 font-body text-sm text-ed-on-surface-muted transition-colors hover:bg-ed-surface-highest disabled:opacity-50 cursor-pointer"
          >
            {loading() ? "Loading..." : "Load more"}
          </button>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={searched() && !loading() && results().length === 0}>
        <p class="py-12 text-center font-body text-sm text-ed-on-surface-muted">
          No books found. Try a different search term.
        </p>
      </Show>

      {/* Loading */}
      <Show when={loading() && results().length === 0}>
        <div class="flex flex-col items-center gap-3 py-12">
          <div class="size-5 animate-spin rounded-full border-2 border-ed-outline border-t-ed-primary" />
          <p class="font-body text-sm text-ed-on-surface-muted">
            Searching...
          </p>
        </div>
      </Show>

      {/* Config modal */}
      <Show when={selectedBook()}>
        <CatalogConfigModal
          book={selectedBook()!}
          onClose={() => setSelectedBook(null)}
        />
      </Show>
    </div>
  );
}
