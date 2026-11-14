"use client";

import { useCallback, useEffect, useState } from "react";
import { initialsOf } from "./primitives";
import { DEMO_ACCOUNT } from "@/lib/demo-data";

/**
 * What every logged-in page's shell needs to know, from one place (docs/web-ia.md § The shell):
 * who is signed in (the avatar and its menu), whether they are the owner (the Admin tab), and how many
 * things are waiting on them (the Home tab's badge and the browser tab's title).
 *
 * The waiting count is the same total the Approvals card on Home shows. `/account` already loads every
 * source for that card, so it computes the total itself with `waitingTotal` and passes `waiting: false`
 * here to skip the duplicate reads. Every other page (Devices, a thread transcript, Admin) lets this hook
 * read the sources: the same endpoints the card reads, nothing new.
 *
 * Everything here is cosmetic: each action behind it is checked again on the server.
 */

/** Each kind of thing that can wait on the person; the Approvals card has one row type per key. */
export interface WaitingCounts {
  /** A friend's agent asking to start a thread (GET /api/inbox). */
  threadRequests: number;
  /** An open thread where it is the person's turn (GET /api/account/sessions, unread). */
  replies: number;
  /** A friend's task the person's agents need an OK for (GET /api/lists/plate → ok_requests). */
  listOks: number;
  /** A finished task waiting to be checked (GET /api/lists/plate → waiting_on_you). */
  reviews: number;
  /** An agent on a PC asking to use a secret (GET /api/secret-broker, open and unexpired). */
  secrets: number;
  /** An agent asking for a one-time help code (GET /api/support/invites → pending). */
  helpCodes: number;
  /** An agent asking to use one of the person's PCs (GET /api/remote-app/sessions → pending). */
  pcSessions: number;
}

export const waitingTotal = (c: Partial<WaitingCounts>): number =>
  Object.values(c).reduce<number>((sum, n) => sum + (typeof n === "number" ? n : 0), 0);

export interface AccountChrome {
  /** The `me` read has answered (signed in or not). */
  ready: boolean;
  signedIn: boolean;
  owner: boolean;
  handle: string | null;
  displayName: string | null;
  /** 1–2 characters for the avatar. */
  userLabel: string;
  /** Things waiting on the person; null until known (or when the page supplies its own). */
  waiting: number | null;
  reloadWaiting: () => void;
}

const getJson = async (path: string) => {
  try { const r = await fetch(path, { credentials: "include" }); return r.ok ? await r.json() : null; } catch { return null; }
};

/** Read every Approvals source and count it. Sources that fail count as zero rather than hiding the rest. */
export async function readWaitingCounts(): Promise<WaitingCounts> {
  const [inbox, sessions, plate, secrets, support, pc] = await Promise.all([
    getJson("/api/inbox"), getJson("/api/account/sessions"), getJson("/api/lists/plate"),
    getJson("/api/secret-broker"), getJson("/api/support/invites"), getJson("/api/remote-app/sessions"),
  ]);
  const now = Date.now();
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    threadRequests: len(inbox?.requests),
    replies: Array.isArray(sessions?.active) ? sessions.active.filter((t: { unread_count?: number }) => (t.unread_count ?? 0) > 0).length : 0,
    listOks: len(plate?.ok_requests),
    reviews: len(plate?.waiting_on_you),
    secrets: Array.isArray(secrets?.requests)
      ? secrets.requests.filter((r: { status?: string; expiresAt?: string }) => r.status === "open" && (!r.expiresAt || new Date(r.expiresAt).getTime() > now)).length
      : 0,
    helpCodes: support?.available ? len(support.pending) : 0,
    pcSessions: len(pc?.pending),
  };
}

export function useAccountChrome({ waiting: readWaiting = true, demo = false }: { waiting?: boolean; demo?: boolean } = {}): AccountChrome {
  const [me, setMe] = useState<{ ready: boolean; signedIn: boolean; owner: boolean; handle: string | null; displayName: string | null }>(
    { ready: false, signedIn: false, owner: false, handle: null, displayName: null });
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    let stop = false;
    getJson("/api/account/me").then((j) => {
      if (stop) return;
      if (j && typeof j.handle === "string") setMe({ ready: true, signedIn: true, owner: j.admin === true, handle: j.handle, displayName: j.display_name ?? null });
      else setMe((m) => ({ ...m, ready: true }));
    });
    return () => { stop = true; };
  }, []);

  const load = useCallback(async () => {
    if (!readWaiting || !me.signedIn) return;
    setWaiting(waitingTotal(await readWaitingCounts()));
  }, [readWaiting, me.signedIn]);

  useEffect(() => { void load(); }, [load]);
  // Some approvals live about 90 s (a secret use): look again while the page is on screen.
  useEffect(() => {
    if (!readWaiting || !me.signedIn) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => clearInterval(t);
  }, [readWaiting, me.signedIn, load]);

  // Non-production, signed out: the demo fixture's person, so the preview reads like the dashboard's.
  const name = me.displayName || me.handle || (demo ? DEMO_ACCOUNT.me.display_name : null);
  return {
    ...me,
    userLabel: name ? initialsOf(name) : "?",
    waiting: readWaiting ? waiting : null,
    reloadWaiting: () => { void load(); },
  };
}
