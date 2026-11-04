import { Show, For } from "solid-js";

export interface Contributor {
  name: string;
  sortName: string;
  lifespan: string | null;
  role: string | null;
}

export interface BookDetailsData {
  gutenbergId: number;
  title: string;
  author: string | null;
  contributors: Contributor[];
  subjects: string[];
  bookshelves: string[];
  language: string | null;
  issuedAt: string | null;
  gutenbergUrl: string;
  coverUrl: string | null;
  cacheStatus: string | null;
  totalCards: number | null;
}

export interface SummaryData {
  summary: string | null;
  downloadCount: number | null;
}

interface Props {
  details: BookDetailsData | null;
  detailsError: string | null;
  summary: SummaryData | null;
  summaryLoading: boolean;
}

function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function SectionLabel(props: { children: string }) {
  return (
    <h3 class="font-body text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ed-primary">
      {props.children}
    </h3>
  );
}

function Chips(props: { items: string[] }) {
  return (
    <div class="flex flex-wrap gap-1.5">
      <For each={props.items}>
        {(item) => (
          <span class="rounded bg-ed-surface-high px-2 py-0.5 font-body text-xs text-ed-on-surface-muted">
            {item}
          </span>
        )}
      </For>
    </div>
  );
}

export default function BookDetails(props: Props) {
  const facts = () => {
    const d = props.details;
    if (!d) return [];
    const rows: { label: string; value: string }[] = [];
    const lang = languageName(d.language);
    if (lang) rows.push({ label: "Language", value: lang });
    if (d.cacheStatus === "ready" && d.totalCards)
      rows.push({ label: "Cards", value: `${d.totalCards} ready` });
    const downloads = props.summary?.downloadCount;
    if (downloads) rows.push({ label: "Downloads", value: `${downloads.toLocaleString()} (last 30 days)` });
    if (d.issuedAt) rows.push({ label: "On Gutenberg since", value: d.issuedAt.slice(0, 4) });
    return rows;
  };

  return (
    <div class="space-y-5">
      <Show when={props.detailsError}>
        <p class="font-body text-sm text-ctp-red">{props.detailsError}</p>
      </Show>

      <Show when={!props.details && !props.detailsError}>
        <div class="space-y-2 animate-pulse">
          <div class="h-3 w-1/2 rounded bg-ed-surface-high" />
          <div class="h-3 w-2/3 rounded bg-ed-surface-high" />
        </div>
      </Show>

      <Show when={props.details}>
        {(d) => (
          <>
            {/* Contributors */}
            <Show when={d().contributors.length > 0}>
              <div class="space-y-1.5">
                <SectionLabel>{d().contributors.length > 1 ? "Authors & contributors" : "Author"}</SectionLabel>
                <ul class="space-y-1">
                  <For each={d().contributors}>
                    {(c) => (
                      <li class="font-body text-sm text-ed-on-surface">
                        {c.name}
                        <Show when={c.lifespan}>
                          <span class="text-ed-on-surface-muted"> ({c.lifespan})</span>
                        </Show>
                        <Show when={c.role}>
                          <span class="text-ed-on-surface-muted"> · {c.role}</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>

            {/* Summary */}
            <div class="space-y-1.5">
              <SectionLabel>About this book</SectionLabel>
              <Show
                when={!props.summaryLoading}
                fallback={
                  <div class="space-y-2 animate-pulse" aria-label="Loading summary">
                    <div class="h-3 rounded bg-ed-surface-high" />
                    <div class="h-3 rounded bg-ed-surface-high" />
                    <div class="h-3 w-4/5 rounded bg-ed-surface-high" />
                  </div>
                }
              >
                <Show
                  when={props.summary?.summary}
                  fallback={
                    <p class="font-body text-sm text-ed-on-surface-muted italic">
                      No summary available. The subjects below may help.
                    </p>
                  }
                >
                  <p class="font-body text-sm leading-relaxed text-ed-on-surface whitespace-pre-line">
                    {props.summary!.summary}
                  </p>
                  <p class="font-body text-[0.65rem] text-ed-on-surface-muted">
                    Automatically generated summary from Project Gutenberg.
                  </p>
                </Show>
              </Show>
            </div>

            {/* Facts */}
            <Show when={facts().length > 0}>
              <dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <For each={facts()}>
                  {(f) => (
                    <div class="min-w-0">
                      <dt class="font-body text-[0.65rem] text-ed-on-surface-muted">{f.label}</dt>
                      <dd class="font-body text-sm text-ed-on-surface">{f.value}</dd>
                    </div>
                  )}
                </For>
              </dl>
            </Show>

            <Show when={d().subjects.length > 0}>
              <div class="space-y-1.5">
                <SectionLabel>Subjects</SectionLabel>
                <Chips items={d().subjects} />
              </div>
            </Show>

            <Show when={d().bookshelves.length > 0}>
              <div class="space-y-1.5">
                <SectionLabel>Bookshelves</SectionLabel>
                <Chips items={d().bookshelves} />
              </div>
            </Show>


            <a
              href={d().gutenbergUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-block font-body text-xs text-ed-primary hover:underline"
            >
              View on Project Gutenberg ↗
            </a>
          </>
        )}
      </Show>
    </div>
  );
}
