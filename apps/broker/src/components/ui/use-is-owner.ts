"use client";

import { useEffect, useState } from "react";

export type OwnerTab = { label: string; href: string };

/** The owner's extra tab as GET /api/account/me sent it, or null. Only a same-site path is accepted. */
export function ownerTabFrom(me: unknown): OwnerTab | null {
  const tab = (me as { owner_tab?: unknown } | null)?.owner_tab as Partial<OwnerTab> | undefined;
  if (!tab || typeof tab.label !== "string" || typeof tab.href !== "string") return null;
  if (!tab.href.startsWith("/") || tab.href.startsWith("//")) return null;
  return { label: tab.label, href: tab.href };
}

/**
 * The extra tab the owner's dashboard shows, or null: while loading, when signed out, for everyone
 * who is not the owner, and on any error. What the tab says and where it goes come from the server
 * (GET /api/account/me includes them for the owner only), so neither is in this script. Purely
 * cosmetic: the page behind the tab and its APIs check the owner again on the server.
 */
export function useOwnerTab(): OwnerTab | null {
  const [tab, setTab] = useState<OwnerTab | null>(null);
  useEffect(() => {
    let stop = false;
    fetch("/api/account/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!stop) setTab(ownerTabFrom(j)); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);
  return tab;
}
