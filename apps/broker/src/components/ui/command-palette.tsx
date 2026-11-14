"use client";

/**
 * ⌘K / Ctrl-K command palette for the logged-in app (from prototype variant A).
 * Pure client-side filter over items the host surface provides — no fetching here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme.css";

export interface PaletteItem {
  id: string;
  /** Group header shown above the item, e.g. "Navigate", "Threads", "Friends", "Toolkit". */
  group: string;
  label: string;
  /** Extra searchable/displayed context (goal, handle, description…). */
  meta?: string;
  /** Searchable but not shown: synonyms, so "api key" finds "Developer key". */
  keywords?: string;
  icon?: string;
  onSelect: () => void;
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

export function CommandPalette({ open, onClose, items }: {
  open: boolean; onClose: () => void; items: PaletteItem[];
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      // Focus after the overlay paints.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    // Every word must match somewhere, in any order: "rotate key" finds "Developer key" (keywords: rotate).
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((it) => {
      const hay = `${it.label} ${it.meta ?? ""} ${it.keywords ?? ""} ${it.group}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, q]);

  // Stable flat order == render order; group headers are display-only.
  const pick = useCallback((it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    it.onSelect();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); pick(filtered[sel]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, sel, onClose, pick]);

  useEffect(() => {
    listRef.current?.querySelector(".ds-pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  let lastGroup = "";
  return (
    <div className="ds-pal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ds-pal" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="ds-pal-input"
          placeholder="Search threads, friends, tools, settings — or jump to a page…"
          aria-label="Search"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
        />
        <div className="ds-pal-list" ref={listRef}>
          {filtered.length === 0 && <div className="ds-pal-empty">Nothing matches &ldquo;{q}&rdquo;.</div>}
          {filtered.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="ds-pal-sec" key={`h-${it.group}`}>{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header}
                <button
                  className={`ds-pal-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(it)}
                >
                  {it.icon && <span aria-hidden>{it.icon}</span>}
                  <span>{it.label}</span>
                  {it.meta && <span className="ds-pal-meta">{it.meta}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="ds-pal-foot">
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span><span style={{ marginLeft: "auto" }}>? all shortcuts</span>
        </div>
      </div>
    </div>
  );
}
