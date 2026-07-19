"use client";

/** PROTOTYPE — minimal hydration canary (branch proto/logged-in-redesign). Delete with the prototype. */

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
