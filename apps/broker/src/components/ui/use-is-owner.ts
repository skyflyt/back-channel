"use client";

import { useEffect, useState } from "react";

/**
 * True when the signed-in account is the owner, so a page can add the Admin tab to its shell.
 * Reads the `admin` member GET /api/account/me includes for the owner only. Purely cosmetic: the
 * tab is a link, and /admin and every admin API check the owner again on the server. False while
 * loading, when signed out, and on any error.
 */
export function useIsOwner(): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    let stop = false;
    fetch("/api/account/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!stop && j?.admin === true) setOwner(true); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);
  return owner;
}
