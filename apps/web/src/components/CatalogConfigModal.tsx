import { createSignal, createMemo, Show, For, onMount, onCleanup } from "solid-js";
import type { CardType, DocumentType, ReadingGoal } from "@scroll-reader/shared-types";
import {
  resolveCardStrategy,
  describeStrategy,
} from "@scroll-reader/shared-types";

interface Book {
  gutenbergId: number;
  title: string;
  author: string | null;
  subjects: string[];
  coverUrl: string | null;
  epubUrl: string | null;
  cacheStatus: string | null;
}

interface Props {
  book: Book;
  onClose: () => void;
}

const CONTENT_OPTIONS: { label: string; value: DocumentType }[] = [
  { label: "Fiction / novel", value: "fiction" },
  { label: "Spiritual / philosophical", value: "scripture" },
  { label: "Non-fiction", value: "book" },
  { label: "Textbook / technical", value: "manual" },
];

const GOAL_OPTIONS: { label: string; value: ReadingGoal }[] = [
  { label: "Just reading", value: "casual" },
  { label: "Reading to reflect", value: "reflective" },
  { label: "Studying to retain", value: "study" },
];

const CARD_TYPE_OPTIONS: { label: string; value: CardType }[] = [
  { label: "Passage", value: "passage" },
  { label: "Discover", value: "discover" },
  { label: "Notes", value: "raw_commentary" },
  { label: "Flashcard", value: "flashcard" },
  { label: "Quiz", value: "quiz" },
  { label: "Glossary", value: "glossary" },
  { label: "Contrast", value: "contrast" },
];

const FREQUENCY_OPTIONS: { label: string; value: number }[] = [
  { label: "Every chunk", value: 1 },
  { label: "Every 2nd chunk", value: 2 },
  { label: "Every 3rd chunk", value: 3 },
];

export default function CatalogConfigModal(props: Props) {
  const [documentType, setDocumentType] = createSignal<DocumentType>("book");
  const [readingGoal, setReadingGoal] = createSignal<ReadingGoal>("reflective");
  const [submitting, setSubmitting] = createSignal(false);
  const [polling, setPolling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [processingStatus, setProcessingStatus] = createSignal<string | null>(
    null,
  );
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [cardTypesOverride, setCardTypesOverride] = createSignal<CardType[] | null>(null);
  const [chunkIntervalOverride, setChunkIntervalOverride] = createSignal<number | null>(null);

  const baseStrategy = createMemo(() =>
    resolveCardStrategy(documentType(), readingGoal()),
  );
  const effectiveStrategy = createMemo(() => ({
    cardTypes: cardTypesOverride() ?? baseStrategy().cardTypes,
    chunkInterval: chunkIntervalOverride() ?? baseStrategy().chunkInterval,
  }));
  const strategyLabel = createMemo(() => describeStrategy(effectiveStrategy()));

  // Try to guess content type from subjects
  onMount(() => {
    const subjects = props.book.subjects.join(" ").toLowerCase();
    if (
      subjects.includes("fiction") ||
      subjects.includes("novel") ||
      subjects.includes("stories")
    ) {
      setDocumentType("fiction");
    } else if (
      subjects.includes("religion") ||
      subjects.includes("spiritual") ||
      subjects.includes("philosophy")
    ) {
      setDocumentType("scripture");
    } else if (
      subjects.includes("textbook") ||
      subjects.includes("manual") ||
      subjects.includes("science")
    ) {
      setDocumentType("manual");
    }
  });

  // Close on Escape
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !submitting()) props.onClose();
  }
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(pollTimer));

  async function pollStatus(catalogBookId: string) {
    setPolling(true);
    setProcessingStatus("processing");

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/catalog/${catalogBookId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        setProcessingStatus(data.status);

        if (data.status === "ready") {
          clearInterval(pollTimer);
          // Now add to library
          await addToLibrary();
        } else if (data.status === "error") {
          clearInterval(pollTimer);
          setPolling(false);
          setSubmitting(false);
          setError(data.error ?? "Processing failed. Please try again later.");
        }
      } catch {
        // Keep polling
      }
    }, 3000);
  }

  async function addToLibrary() {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/catalog/${props.book.gutenbergId}/add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentType: documentType(),
            readingGoal: readingGoal(),
            ...(cardTypesOverride() ? { cardTypesOverride: cardTypesOverride() } : {}),
            ...(chunkIntervalOverride() ? { chunkIntervalOverride: chunkIntervalOverride() } : {}),
            title: props.book.title,
            author: props.book.author,
            subjects: props.book.subjects,
            languages: ['en'],
            coverUrl: props.book.coverUrl,
            epubUrl: props.book.epubUrl,
          }),
        },
      );

      const data = await res.json();

      if (res.status === 202) {
        // Processing started — poll for completion
        await pollStatus(data.catalogBookId);
        return;
      }

      if (res.status === 409) {
        // Already in library
        window.location.href = `/doc/${data.documentId}`;
        return;
      }

      if (!res.ok) {
        setError(data.error ?? "Failed to add book.");
        setSubmitting(false);
        return;
      }

      // Success — redirect to doc page
      window.location.href = `/doc/${data.documentId}`;
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
      setPolling(false);
    }
  }

  const isProcessing = () => submitting() || polling();
  const isCached = () => props.book.cacheStatus === "ready";

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isProcessing()) props.onClose();
      }}
    >
      <div class="w-full max-w-lg rounded-lg bg-ed-surface p-6 space-y-5 shadow-xl">
        {/* Header */}
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="font-display text-lg text-ed-on-surface truncate">
              {props.book.title}
            </h2>
            <Show when={props.book.author}>
              <p class="font-body text-sm text-ed-on-surface-muted">
                {props.book.author}
              </p>
            </Show>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            disabled={isProcessing()}
            class="shrink-0 text-ed-on-surface-muted hover:text-ed-on-surface transition-colors disabled:opacity-50"
          >
            <svg
              class="size-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Processing status overlay */}
        <Show when={polling()}>
          <div class="rounded bg-ed-surface-high px-4 py-6 text-center space-y-3">
            <div class="size-5 mx-auto animate-spin rounded-full border-2 border-ed-outline border-t-ed-primary" />
            <p class="font-body text-sm text-ed-on-surface">
              Preparing this book for the first time...
            </p>
            <p class="font-body text-xs text-ed-on-surface-muted">
              This may take a few minutes. The book will be instantly available
              for future readers.
            </p>
          </div>
        </Show>

        {/* Config form */}
        <Show when={!polling()}>
          <Show when={isCached()}>
            <p class="rounded-full bg-ed-primary-container px-3 py-1 inline-block font-body text-xs font-semibold text-ed-primary">
              Ready — cards are pre-generated
            </p>
          </Show>

          {/* Content type */}
          <fieldset class="space-y-2">
            <legend class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
              What kind of content is this?
            </legend>
            <div class="flex flex-wrap gap-2">
              {CONTENT_OPTIONS.map((opt) => (
                <label
                  class={`cursor-pointer rounded px-3 py-1.5 font-body text-sm transition-colors ${
                    documentType() === opt.value
                      ? "bg-ed-primary-container text-ed-on-surface"
                      : "bg-ed-surface-high text-ed-on-surface-muted hover:bg-ed-surface-highest"
                  }`}
                >
                  <input
                    type="radio"
                    name="catalogDocType"
                    value={opt.value}
                    checked={documentType() === opt.value}
                    onChange={() => setDocumentType(opt.value)}
                    class="sr-only"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Reading goal */}
          <fieldset class="space-y-2">
            <legend class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
              What's your goal?
            </legend>
            <div class="flex flex-wrap gap-2">
              {GOAL_OPTIONS.map((opt) => (
                <label
                  class={`cursor-pointer rounded px-3 py-1.5 font-body text-sm transition-colors ${
                    readingGoal() === opt.value
                      ? "bg-ed-primary-container text-ed-on-surface"
                      : "bg-ed-surface-high text-ed-on-surface-muted hover:bg-ed-surface-highest"
                  }`}
                >
                  <input
                    type="radio"
                    name="catalogGoal"
                    value={opt.value}
                    checked={readingGoal() === opt.value}
                    onChange={() => setReadingGoal(opt.value)}
                    class="sr-only"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Advanced card settings */}
          <div class="space-y-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen())}
              class="flex items-center gap-1.5 font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-on-surface-muted hover:text-ed-primary transition-colors cursor-pointer"
            >
              <span class={`transition-transform ${advancedOpen() ? "rotate-90" : ""}`}>&#9654;</span>
              Advanced
            </button>
            <Show when={advancedOpen()}>
              <div class="space-y-4 pl-4 border-l border-ed-outline">
                {/* Card types */}
                <fieldset class="space-y-2">
                  <legend class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
                    Card types
                  </legend>
                  <div class="flex flex-wrap gap-2">
                    <For each={CARD_TYPE_OPTIONS}>
                      {(opt) => {
                        const isSelected = () => {
                          const override = cardTypesOverride();
                          const types = override ?? baseStrategy().cardTypes;
                          return types.includes(opt.value);
                        };
                        return (
                          <label
                            class={`cursor-pointer rounded px-3 py-1.5 font-body text-sm transition-colors ${
                              isSelected()
                                ? "bg-ed-primary-container text-ed-on-surface"
                                : "bg-ed-surface-high text-ed-on-surface-muted hover:bg-ed-surface-highest"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected()}
                              onChange={() => {
                                const current = cardTypesOverride() ?? [...baseStrategy().cardTypes];
                                const next = isSelected()
                                  ? current.filter((t) => t !== opt.value)
                                  : [...current, opt.value];
                                setCardTypesOverride(next.length > 0 ? next : null);
                              }}
                              class="sr-only"
                            />
                            {opt.label}
                          </label>
                        );
                      }}
                    </For>
                  </div>
                </fieldset>

                {/* Frequency */}
                <fieldset class="space-y-2">
                  <legend class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
                    Frequency
                  </legend>
                  <div class="flex flex-wrap gap-2">
                    <For each={FREQUENCY_OPTIONS}>
                      {(opt) => {
                        const isSelected = () => {
                          const interval = chunkIntervalOverride() ?? baseStrategy().chunkInterval;
                          return interval === opt.value;
                        };
                        return (
                          <label
                            class={`cursor-pointer rounded px-3 py-1.5 font-body text-sm transition-colors ${
                              isSelected()
                                ? "bg-ed-primary-container text-ed-on-surface"
                                : "bg-ed-surface-high text-ed-on-surface-muted hover:bg-ed-surface-highest"
                            }`}
                          >
                            <input
                              type="radio"
                              name="catalogChunkInterval"
                              value={opt.value}
                              checked={isSelected()}
                              onChange={() => setChunkIntervalOverride(opt.value)}
                              class="sr-only"
                            />
                            {opt.label}
                          </label>
                        );
                      }}
                    </For>
                  </div>
                </fieldset>
              </div>
            </Show>
          </div>

          {/* Strategy preview */}
          <p class="font-body text-sm text-ed-on-surface-muted italic">
            {strategyLabel()}
          </p>
        </Show>

        {/* Error */}
        <Show when={error()}>
          <p class="font-body text-sm text-ctp-red">{error()}</p>
        </Show>

        {/* Actions */}
        <Show when={!polling()}>
          <div class="flex gap-3 justify-end">
            <button
              type="button"
              onClick={props.onClose}
              disabled={isProcessing()}
              class="rounded px-4 py-2 font-body text-sm text-ed-on-surface-muted hover:bg-ed-surface-high transition-colors disabled:opacity-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={addToLibrary}
              disabled={isProcessing()}
              class="rounded bg-ed-primary px-5 py-2 font-body text-sm font-medium text-ed-on-primary transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {submitting()
                ? "Adding..."
                : isCached()
                  ? "Add to library"
                  : "Add to library"}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
