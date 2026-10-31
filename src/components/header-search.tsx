"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { openDocId, suggest, type SuggestResult } from "@/lib/search/actions";
import {
  MIN_SUGGEST_CHARS, SEARCH_TEXT_KEY, SUGGEST_DEBOUNCE_MS, normaliseSearchText, parseDocId,
} from "@/lib/validation/document-search";

// Spec 03b AC-1…AC-4, AC-11 — the header search (mockup 01: "Search clients, documents, DOC id…" with the "/" hint).
// An ARIA 1.2 combobox: focus stays in the input, options are referenced with aria-activedescendant.
// The typed text only ever leaves the browser in a server-action POST body; "See all" hands it to /documents through
// this tab's session storage. Nothing here puts the text in a URL.

export const PLACEHOLDER = "Search clients, documents, DOC id…";
/** Below this width the box collapses to a search button (AC-1). Matches Tailwind's `sm`. */
const MOBILE_MAX = 639;
/** /documents listens for this to pick up new text when it is already open. */
export const SEARCH_TEXT_EVENT = "cdv:documents-search-text";

type Ok = Extract<SuggestResult, { ok: true }>;
type Option =
  | { kind: "client"; key: string; id: string; label: string }
  | { kind: "document"; key: string; id: string; label: string; archived: boolean }
  | { kind: "all"; key: string; label: string };

/** "/" must not steal focus from anything the user is typing into (AC-1). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest("[contenteditable]:not([contenteditable='false'])")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Writes the hand-off text; storage can be unavailable (private mode, quota) — then /documents just starts empty. */
export function handOffSearchText(text: string) {
  try {
    if (text) window.sessionStorage.setItem(SEARCH_TEXT_KEY, text);
    else window.sessionStorage.removeItem(SEARCH_TEXT_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SEARCH_TEXT_EVENT));
}

const join = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");

function toOptions(res: Ok | null, text: string): Option[] {
  const out: Option[] = [];
  for (const c of res?.clients ?? []) out.push({ kind: "client", key: `c-${c.id}`, id: c.id, label: join([c.name, c.code]) });
  for (const d of res?.documents ?? []) {
    out.push({
      kind: "document", key: `d-${d.id}`, id: d.id, archived: d.archived,
      label: join([d.docCode, d.typeName ?? "No type", d.periodLabel ?? d.periodCode, d.clientName ?? "Untagged", d.fileName]),
    });
  }
  if (text.length >= MIN_SUGGEST_CHARS) out.push({ kind: "all", key: "all", label: `See all results for “${text}”` });
  return out;
}

export function HeaderSearch() {
  const router = useRouter();
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  const [text, setText] = useState("");
  // The latest answer and the text it answered; loading and results are derived from it.
  const [answer, setAnswer] = useState<{ q: string; res: Ok | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null); // errors, and "No document … you can open"
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [mobileOpen, setMobileOpen] = useState(false);

  const query = normaliseSearchText(text);
  const searching = query.length >= MIN_SUGGEST_CHARS;
  const result = searching ? answer?.res ?? null : null; // the previous answer stays visible while the next loads
  const loading = searching && answer?.q !== query;
  const options = useMemo(() => toOptions(result, query), [result, query]);
  const clientOptions = options.filter((o) => o.kind === "client");
  const documentOptions = options.filter((o) => o.kind === "document");
  const allOption = options.find((o) => o.kind === "all");
  const showList = open && searching;

  // AC-2: suggestions after 2+ characters and a 250 ms pause; an answer to an older request is ignored.
  useEffect(() => {
    const id = ++request.current;
    if (query.length < MIN_SUGGEST_CHARS) return;
    const timer = window.setTimeout(async () => {
      const r = await suggest(query).catch(() => ({ ok: false as const, error: "Could not load suggestions. Please try again." }));
      if (id !== request.current) return; // a newer search has started
      // Keeps any message: a DOC-ID "can't open" answer may arrive before these suggestions.
      if (r.ok) setAnswer({ q: query, res: r });
      else {
        setAnswer({ q: query, res: null });
        setMessage(r.error);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // AC-1: "/" focuses the box unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (window.innerWidth <= MOBILE_MAX) setMobileOpen(true);
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (mobileOpen) inputRef.current?.focus();
  }, [mobileOpen]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function finish(href: string) {
    close();
    setMobileOpen(false);
    router.push(href);
  }

  function seeAll() {
    handOffSearchText(query);
    finish("/documents");
  }

  function choose(o: Option) {
    if (o.kind === "client") finish(`/clients/${o.id}`);
    else if (o.kind === "document") finish(`/documents/${o.id}`);
    else seeAll();
  }

  async function enterWithoutOption() {
    const code = parseDocId(query);
    if (!code) {
      if (query) seeAll();
      return;
    }
    // AC-3: a complete DOC-ID opens that document directly, if the user can open it.
    const r = await openDocId(code).catch(() => ({ ok: false as const, error: "Could not open that document. Please try again." }));
    if (r.ok) finish(`/documents/${r.id}`);
    else {
      setMessage(r.error);
      setOpen(true);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!n) return;
      setOpen(true);
      setActive((a) => (a + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      setOpen(true);
      setActive((a) => (a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showList && active >= 0 && options[active]) choose(options[active]);
      else void enterWithoutOption();
    } else if (e.key === "Escape") {
      if (showList) {
        e.preventDefault();
        close();
      } else if (mobileOpen) {
        e.preventDefault();
        setMobileOpen(false);
      }
    }
  }

  const status = !showList
    ? ""
    : loading
      ? "Searching…"
      : result
        ? result.clients.length + result.documents.length === 0
          ? "No matching clients or documents"
          : `${result.clients.length} clients and ${result.documents.length} documents`
        : "";

  const optionId = (i: number) => `${listId}-${i}`;
  const indexOf = (o: Option) => options.indexOf(o);
  const renderOption = (o: Option) => {
    const i = indexOf(o);
    const selected = i === active;
    return (
      <li key={o.key} id={optionId(i)} role="option" aria-selected={selected}
        onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
        className={`cursor-pointer truncate rounded-lg px-3 py-2 text-[13.5px] ${selected ? "bg-accent-soft text-ink" : "text-ink-2"} ${o.kind === "all" ? "font-medium text-accent" : ""}`}>
        {o.label}
        {o.kind === "document" && o.archived ? <span className="ml-2 rounded-full bg-canvas px-2 py-0.5 text-xs text-ink-2">Archived</span> : null}
      </li>
    );
  };

  return (
    <div className="flex shrink-0 items-center">
      {/* AC-1: below 640 px a button opens a full-width field, so the header still fits 390 px. */}
      <button type="button" aria-label="Search" onClick={() => setMobileOpen(true)}
        className="grid h-9 w-9 place-items-center rounded-lg text-ink-2 hover:bg-canvas sm:hidden">
        <SearchIcon />
      </button>
      <div
        className={mobileOpen
          ? "fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-white px-4"
          : "relative hidden sm:block"}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
        }}
      >
        <div className="relative w-full sm:w-52 lg:w-72">
          <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"><SearchIcon /></span>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search clients and documents"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
            aria-keyshortcuts="/"
            autoComplete="off"
            spellCheck={false}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(-1);
              setMessage(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className="h-9 w-full rounded-lg border border-line-2 bg-white pl-8 pr-8 text-[13.5px] placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line-2 px-1.5 text-xs text-ink-3 sm:block">/</kbd>
        </div>
        {mobileOpen && (
          <button type="button" aria-label="Close search" onClick={() => setMobileOpen(false)} className="shrink-0 rounded-lg px-2 py-1.5 text-[13.5px] text-ink-2 hover:bg-canvas">
            Close
          </button>
        )}
        {/* aria-live without role="status": the header is on every page, and pages own their single status region. */}
        <p aria-live="polite" aria-atomic="true" data-testid="search-status" className="sr-only">{status}</p>
        <div
          hidden={!showList}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the input while clicking an option */}
          className={`${mobileOpen ? "fixed inset-x-0 top-14 max-h-[calc(100vh-3.5rem)]" : "absolute right-0 top-full mt-2 max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] rounded-xl"} z-30 overflow-y-auto border border-line bg-panel p-2 shadow-card`}
        >
          {message && <p role="alert" className="px-3 py-2 text-[13.5px] text-bad">{message}</p>}
          {!loading && result && clientOptions.length + documentOptions.length === 0 && (
            <p className="px-3 py-2 text-[13.5px] text-ink-2">No matching clients or documents.</p>
          )}
          {loading && !result && <p className="px-3 py-2 text-[13.5px] text-ink-2">Searching…</p>}
          <div id={listId} role="listbox" aria-label="Search suggestions">
            {clientOptions.length > 0 && (
              <ul role="group" aria-labelledby={`${listId}-clients`}>
                <li role="presentation" id={`${listId}-clients`} className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-3">Clients</li>
                {clientOptions.map(renderOption)}
              </ul>
            )}
            {documentOptions.length > 0 && (
              <ul role="group" aria-labelledby={`${listId}-documents`}>
                <li role="presentation" id={`${listId}-documents`} className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-3">Documents</li>
                {documentOptions.map(renderOption)}
              </ul>
            )}
            {allOption && (
              <ul role="group" aria-label="All results" className="mt-1 border-t border-line pt-1">{renderOption(allOption)}</ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.75" />
      <path d="m10.5 10.5 3.25 3.25" />
    </svg>
  );
}
