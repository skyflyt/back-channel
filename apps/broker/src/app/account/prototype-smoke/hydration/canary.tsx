"use client";

/** Minimal hydration canary: the title and the data-mounted attribute flip once React commits. */

import { useEffect, useState } from "react";

export default function HydrationCanary() {
  const [n, setN] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); document.title = "HYDRATED"; }, []);
  return (
    <main style={{ fontFamily: "monospace", padding: 40 }}>
      <h1 id="canary" data-mounted={mounted ? "yes" : "no"}>canary: {mounted ? "HYDRATED" : "ssr-only"}</h1>
      <button onClick={() => setN(n + 1)}>clicked {n} times</button>
    </main>
  );
}
