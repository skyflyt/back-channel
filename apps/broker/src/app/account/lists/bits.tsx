"use client";
/**
 * Small pieces the Lists tab, the task drawer and the My plate card share.
 */
import "./lists.css";
import { useMemo } from "react";
import { Chip, hueFor } from "@/components/ui/primitives";
import { dueInfo, attribution, REACTIONS, REACTION_LABEL, type PersonRef, type ReactionCount, type ReactionEmoji } from "./api";
import { mentionSpans, type MentionDirectory } from "./mentions.mjs";

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
 * A person's avatar. An agent shows its person's avatar with an agent badge,
 * because agents act for their person ("Alex · via Codex"). `pulse` adds a
 * quiet ring while an agent is working on something.
 */
export function WhoAvatar({ who, size = 30, pulse = false }: { who: PersonRef | null | undefined; size?: number; pulse?: boolean }) {
  const label = attribution(who);
  const key = who?.handle ?? who?.person ?? "?";
  const face = who?.person ?? "?";
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

/** "Alex · via Codex" with the agent part set apart, next to an avatar. */
export function Byline({ who }: { who: PersonRef | null | undefined }) {
  const text = attribution(who);
  const cut = text.indexOf(" · via ");
  if (cut < 0) return <>{text}</>;
  return <>{text.slice(0, cut)}<span className="ds-via"> · via {text.slice(cut + 7)}</span></>;
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

/**
 * Plain text with the @mentions that reached someone highlighted. Built from
 * text spans, never HTML (production CSP enforces Trusted Types).
 */
export function MentionText({ text, dir, author, className, inline = false }: {
  text: string; dir: MentionDirectory; author: PersonRef | null | undefined; className?: string; inline?: boolean;
}) {
  const spans = useMemo(() => mentionSpans(text, dir, author ? { handle: author.handle, agent: author.agent } : null), [text, dir, author]);
  const Tag = inline ? "span" : "div";
  return (
    <Tag className={className} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {spans.map((s, i) => (s.kind ? <span key={i} className={`ds-mention${s.you ? " you" : ""}`} title={s.title}>{s.text}</span> : s.text))}
    </Tag>
  );
}

/**
 * Reaction chips: tap to add yours, tap again to take it back. `all` shows the
 * four you can give even before anyone has; otherwise only the ones given.
 */
export function Reactions({ reactions, all = false, disabled = false, busy, onToggle }: {
  reactions: ReactionCount[]; all?: boolean; disabled?: boolean; busy?: ReactionEmoji | null; onToggle: (emoji: ReactionEmoji) => void;
}) {
  const shown = REACTIONS.map((emoji) => ({ emoji, r: reactions.find((x) => x.emoji === emoji) })).filter((x) => all || x.r);
  if (!shown.length) return null;
  return (
    <div className="ds-reacts" role="group" aria-label="Reactions">
      {shown.map(({ emoji, r }) => {
        const label = REACTION_LABEL[emoji];
        const title = r?.you ? `Take back your ${label}` : `React with ${label}`;
        return (
          <button key={emoji} type="button" className={`ds-react${r?.you ? " you" : ""}${r ? "" : " empty"}`} aria-pressed={!!r?.you}
            aria-label={`${label}${r ? `, ${r.count}` : ""}${r?.you ? ", including you" : ""}`} title={title}
            disabled={disabled || busy === emoji} onClick={() => onToggle(emoji)}>
            <span aria-hidden>{emoji}</span>{r && <span className="ds-react-n">{r.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
