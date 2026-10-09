"use client";
/**
 * "Email me a daily summary" in the Lists tab (Phase 3, docs/lists.md): the
 * opt-in daily digest, off by default. When it's on, Back Channel emails at
 * the hour picked here, in this browser's timezone: what your agents finished
 * since the last one, what needs your look or OK, and what's overdue. Task
 * titles and counts only, and nothing on a quiet day.
 */
import { useEffect, useState } from "react";
import { listsApi, errorText, type ListsPreferences } from "./api";

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "8:00 AM" or "08:00", the way this browser writes times. */
const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function DailySummary() {
  const [pref, setPref] = useState<ListsPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [zone] = useState(browserZone);

  useEffect(() => {
    let live = true;
    listsApi.preferences()
      .then((r) => { if (live) setPref(r.preferences); })
      .catch(() => { /* the control just doesn't show; the rest of the tab is unaffected */ });
    return () => { live = false; };
  }, []);

  if (!pref) return null;

  const save = async (body: Parameters<typeof listsApi.updatePreferences>[0]) => {
    setBusy(true); setErr("");
    try {
      setPref((await listsApi.updatePreferences(body)).preferences);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const on = pref.digest === "daily";
  const elsewhere = on && !!zone && !!pref.timezone && pref.timezone !== zone;
  return (
    <div className="ds-lists-digest">
      <div className="ds-lists-sec">Daily summary</div>
      <label className="ds-check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy || (!on && !pref.email_ready)}
          onChange={() => void save(on ? { digest: "off" } : { digest: "daily", ...(zone ? { timezone: zone } : {}) })}
        />
        <span>Email me a daily summary</span>
      </label>
      {on && (
        <div className="ds-lists-digest-hour">
          <label className="ds-fine" htmlFor="ds-digest-hour">at</label>
          <select id="ds-digest-hour" className="ds-select ds-sm" value={pref.digest_hour} disabled={busy}
            onChange={(e) => void save({ digest_hour: Number(e.target.value), ...(zone ? { timezone: zone } : {}) })}>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span className="ds-fine">your time</span>
        </div>
      )}
      <p className="ds-fine" style={{ margin: "2px 2px 0" }}>
        {!pref.email_ready
          ? "Add and verify an email address first, in Settings."
          : on
            ? "What your agents finished, what needs your look or OK, and what's overdue. Task titles only, and nothing on a quiet day."
            : "Once a day: what your agents finished, what needs your look or OK, and what's overdue. Task titles only."}
        {elsewhere && (
          <> It goes out on {pref.timezone} time. <button type="button" className="ds-link" style={{ fontSize: 12 }} disabled={busy} onClick={() => void save({ timezone: zone })}>Use {zone}</button></>
        )}
      </p>
      {err && <p className="ds-err" role="alert">{err}</p>}
    </div>
  );
}
