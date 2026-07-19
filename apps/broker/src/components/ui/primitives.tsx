"use client";

/**
 * Small shared building blocks for the logged-in design system.
 * See theme.css for the token layer and docs/logged-in-redesign.md for the verdict
 * that established this system.
 */

import "./theme.css";

/* ---------- helpers ---------- */

export const shortHandle = (h: string) => h.replace(/@bc$/, "");
export const initialsOf = (h: string) => shortHandle(h).slice(0, 2).toUpperCase();

const AVATAR_HUES = ["#635bff", "#0ea5e9", "#059669", "#d946ef", "#f59e0b", "#f43f5e"];
export const hueFor = (s: string) =>
  AVATAR_HUES[s.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_HUES.length];

/** Compact relative time — "now", "12m", "3h", "5d", "2w". */
export function agoShort(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

/* ---------- atoms ---------- */

export function PersonAvatar({ handle, size = 34 }: { handle: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        background: hueFor(handle), width: size, height: size, fontSize: Math.round(size * 0.36),
        borderRadius: "50%", flexShrink: 0, display: "inline-flex", alignItems: "center",
        justifyContent: "center", color: "#fff", fontWeight: 700,
      }}
    >
      {initialsOf(handle)}
    </span>
  );
}

export function Chip({ tone, children, title }: { tone?: "acc" | "ok" | "warn"; children: React.ReactNode; title?: string }) {
  return <span className={`ds-chip${tone ? ` ${tone}` : ""}`} title={title}>{children}</span>;
}

export function MetricCard({ label, value, note, accent, children }: {
  label: string; value: React.ReactNode; note?: React.ReactNode; accent?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="ds-card" style={accent ? { borderColor: "var(--ds-acc-line)" } : undefined}>
      <div className="ds-mlabel">{label}</div>
      <div className="ds-mval" style={accent ? { color: "var(--ds-acc)" } : undefined}>{value}</div>
      {note && <div className="ds-mnote">{note}</div>}
      {children}
    </div>
  );
}

export function EmptyState({ icon, children }: { icon?: string; children: React.ReactNode }) {
  return (
    <div className="ds-empty">
      {icon && <span className="ds-empty-ico" aria-hidden>{icon}</span>}
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ds-skel" style={{ height: 13, marginBottom: 10, width: `${92 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}

export function HealthDot({ color, label }: { color: string; label?: string }) {
  return (
    <span
      title={label}
      style={{ width: 9, height: 9, borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }}
    />
  );
}
