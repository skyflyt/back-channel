"use client";
/**
 * Small pieces the Lists tab, the task drawer and the My plate card share.
 */
import "./lists.css";
import { Chip, hueFor } from "@/components/ui/primitives";
import { dueInfo, whoName, type PersonRef } from "./api";

const initials = (name: string) => {
  const words = name.replace(/@bc$/, "").split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
};

/** A tiny robot head for the agent badge. */
function AgentGlyph({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden focusable="false">
      <rect x="1.5" y="3" width="9" height="7" rx="2" fill="currentColor" />
      <rect x="5.4" y="0.6" width="1.2" height="2.6" rx="0.6" fill="currentColor" />
      <circle cx="4.4" cy="6.4" r="1" fill="#30313d" />
      <circle cx="7.6" cy="6.4" r="1" fill="#30313d" />
    </svg>
  );
}

/**
 * A person's avatar, or an agent's with a badge. `pulse` adds a quiet ring
 * while an agent is working on something.
 */
export function WhoAvatar({ who, size = 30, pulse = false }: { who: PersonRef | null | undefined; size?: number; pulse?: boolean }) {
  const label = whoName(who);
  const key = who?.agent ? `${who.person}:${who.agent}` : who?.handle ?? who?.person ?? "?";
  const face = who?.agent ?? who?.person ?? "?";
  return (
    <span className={`ds-who${pulse && who?.agent ? " pulse" : ""}`} title={label} aria-label={label} role="img">
      <span className="ds-who-face" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: hueFor(key) }}>
        {initials(face)}
      </span>
      {who?.agent && (
        <span className="ds-who-badge" aria-hidden style={{ width: Math.max(10, Math.round(size * 0.4)), height: Math.max(10, Math.round(size * 0.4)) }}>
          <AgentGlyph size={Math.max(7, Math.round(size * 0.28))} />
        </span>
      )}
    </span>
  );
}

export function DueChip({ due }: { due: string | null | undefined }) {
  const info = dueInfo(due);
  if (!info) return null;
  return <Chip tone={info.tone}>{info.label}</Chip>;
}

/** Plain text with its line breaks kept. Never HTML. */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <div className={className} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</div>;
}
