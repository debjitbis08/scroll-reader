import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import type { CardType, DocumentType, ReadingGoal } from "@scroll-reader/shared-types";
import {
  resolveCardStrategy,
  describeStrategy,
} from "@scroll-reader/shared-types";

interface TocEntry {
  title: string;
  page: number;
  level: number;
  fragment?: string;
}

interface Props {
  docId: string;
  totalPages: number;
  initialStart: number;
  initialEnd: number;
  toc?: TocEntry[];
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

export default function PageRangeSelector(props: Props) {
  const [start, setStart] = createSignal(props.initialStart);
  const [end, setEnd] = createSignal(props.initialEnd);
  const [documentType, setDocumentType] = createSignal<DocumentType>("book");
  const [readingGoal, setReadingGoal] = createSignal<ReadingGoal>("reflective");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [cardTypesOverride, setCardTypesOverride] = createSignal<CardType[] | null>(null);
  const [chunkIntervalOverride, setChunkIntervalOverride] = createSignal<number | null>(null);

  const [tocData, setTocData] = createSignal<TocEntry[]>(props.toc ?? []);
  const [refreshing, setRefreshing] = createSignal(false);
  const hasToc = () => tocData().length > 0;
  const toc = tocData;

  // Detect if TOC has entries with missing titles (stale data from old extractor)
  const hasMissingTitles = () =>
    tocData().length > 0 && tocData().some((e) => !e.title);

  async function refreshToc() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/documents/${props.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToc: true }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.toc) {
        setTocData(data.toc);
        setSelectedChapters(new Set(data.toc.map((_: TocEntry, i: number) => i)));
      }
    } finally {
      setRefreshing(false);
    }
  }

  // Track selected chapter indices (0-based into toc array)
  const [selectedChapters, setSelectedChapters] = createSignal<Set<number>>(
    new Set(toc().map((_, i) => i)),
  );

  // When chapter selection changes, update page range
  createEffect(() => {
    if (!hasToc()) return;
    const selected = selectedChapters();
    if (selected.size === 0) return;

    const tocEntries = toc();
    let minPage = Infinity;
    let maxPage = 0;

    for (const idx of selected) {
      const entry = tocEntries[idx];
      if (!entry) continue;
      if (entry.page < minPage) minPage = entry.page;
      // Find end of this chapter: next entry at same or higher level
      const nextEntry = tocEntries.find(
        (e, i) => i > idx && e.level <= entry.level,
      );
      const chapterEnd = nextEntry ? nextEntry.page - 1 : props.totalPages;
      if (chapterEnd > maxPage) maxPage = chapterEnd;
    }

    if (minPage !== Infinity) {
      setStart(minPage);
      setEnd(Math.min(maxPage, props.totalPages));
    }
  });

  function toggleChapter(idx: number) {
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function selectAll() {
    setSelectedChapters(new Set(toc().map((_, i) => i)));
  }

  function deselectAll() {
    setSelectedChapters(new Set() as Set<number>);
  }

  const baseStrategy = createMemo(() =>
    resolveCardStrategy(documentType(), readingGoal()),
  );
  const effectiveStrategy = createMemo(() => ({
    cardTypes: cardTypesOverride() ?? baseStrategy().cardTypes,
    chunkInterval: chunkIntervalOverride() ?? baseStrategy().chunkInterval,
  }));
  const strategyLabel = createMemo(() => describeStrategy(effectiveStrategy()));

  const handleSubmit = async () => {
    if (start() < 1 || end() > props.totalPages || start() > end()) {
      setError("Invalid page range.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/documents/${props.docId}/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageStart: start(),
          pageEnd: end(),
          documentType: documentType(),
          readingGoal: readingGoal(),
          ...(hasToc()
            ? { selectedTocIndices: Array.from(selectedChapters()) }
            : {}),
          ...(cardTypesOverride() ? { cardTypesOverride: cardTypesOverride() } : {}),
          ...(chunkIntervalOverride() ? { chunkIntervalOverride: chunkIntervalOverride() } : {}),
        }),
      });

      if (!res.ok) {
        const msg = await res.text();
        setError(msg || "Failed to start processing.");
        setSubmitting(false);
        return;
      }

      window.location.reload();
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div class="rounded bg-ed-surface-high p-6 space-y-6">
      <div class="space-y-1">
        <h2 class="font-display text-xl text-ed-on-surface">
          Configure processing
        </h2>
        <p class="font-body text-sm text-ed-on-surface-muted">
          This document has {props.totalPages} page
          {props.totalPages !== 1 ? "s" : ""}.
        </p>
      </div>

      {/* Chapter selection (when TOC is available) */}
      <Show when={hasToc()}>
        <fieldset class="space-y-2">
          <legend class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
            Chapters to process
          </legend>
          <div class="flex gap-3 mb-2">
            <button
              type="button"
              onClick={selectAll}
              class="font-body text-xs text-ed-primary hover:underline"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={deselectAll}
              class="font-body text-xs text-ed-on-surface-muted hover:underline"
            >
              Deselect all
            </button>
          </div>
          <Show when={hasMissingTitles()}>
            <button
              type="button"
              onClick={refreshToc}
              disabled={refreshing()}
              class="font-body text-xs text-ed-on-surface-muted hover:text-ed-primary transition-colors disabled:opacity-50"
            >
              {refreshing() ? "Refreshing..." : "Chapter names missing — click to refresh"}
            </button>
          </Show>
          <div class="max-h-64 overflow-y-auto space-y-0.5 rounded bg-ed-surface p-2">
            <For each={toc()}>
              {(entry, idx) => (
                <label
                  class={`flex items-start gap-2 rounded px-2 py-1 cursor-pointer transition-colors ${
                    selectedChapters().has(idx())
                      ? "bg-ed-primary-container text-ed-on-surface"
                      : "text-ed-on-surface-muted hover:bg-ed-surface-high"
                  }`}
                  style={{ "padding-left": `${entry.level * 16 + 8}px` }}
                >
                  <input
                    type="checkbox"
                    checked={selectedChapters().has(idx())}
                    onChange={() => toggleChapter(idx())}
                    class="mt-0.5 accent-ed-primary"
                  />
                  <span class="font-body text-sm leading-snug">
                    {entry.title || `Page ${entry.page}`}
                  </span>
                </label>
              )}
            </For>
          </div>
        </fieldset>
      </Show>

      {/* Page range — fallback when no TOC */}
      <Show when={!hasToc()}>
        <div class="flex items-center gap-3">
          <label class="font-body text-sm text-ed-on-surface-muted">Pages</label>
          <input
            type="number"
            min={1}
            max={props.totalPages}
            value={start()}
            onInput={(e) => setStart(parseInt(e.currentTarget.value, 10) || 1)}
            class="w-20 border-b border-ed-outline bg-transparent px-1 py-1 font-body text-sm text-ed-on-surface outline-none focus:border-ed-primary transition-colors"
          />
          <span class="font-body text-sm text-ed-on-surface-muted">to</span>
          <input
            type="number"
            min={1}
            max={props.totalPages}
            value={end()}
            onInput={(e) =>
              setEnd(parseInt(e.currentTarget.value, 10) || props.totalPages)
            }
            class="w-20 border-b border-ed-outline bg-transparent px-1 py-1 font-body text-sm text-ed-on-surface outline-none focus:border-ed-primary transition-colors"
          />
          <span class="font-body text-sm text-ed-on-surface-muted">
            of {props.totalPages}
          </span>
        </div>
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
                  : "bg-ed-surface-highest text-ed-on-surface-muted hover:bg-ed-surface-highest"
              }`}
            >
              <input
                type="radio"
                name="documentType"
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
                  : "bg-ed-surface-highest text-ed-on-surface-muted hover:bg-ed-surface-highest"
              }`}
            >
              <input
                type="radio"
                name="readingGoal"
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
                            : "bg-ed-surface-highest text-ed-on-surface-muted hover:bg-ed-surface-highest"
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
                            : "bg-ed-surface-highest text-ed-on-surface-muted hover:bg-ed-surface-highest"
                        }`}
                      >
                        <input
                          type="radio"
                          name="chunkInterval"
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

      {error() && (
        <p class="font-body text-sm text-ctp-red">{error()}</p>
      )}

      <button
        onClick={handleSubmit}
        disabled={submitting()}
        class="rounded bg-ed-primary px-6 py-2.5 font-body font-medium text-ed-on-primary transition-opacity hover:opacity-90 disabled:opacity-50 cursor-pointer"
      >
        {submitting() ? "Starting…" : "Start processing"}
      </button>
    </div>
  );
}
