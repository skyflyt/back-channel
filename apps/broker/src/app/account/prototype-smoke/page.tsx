"use client";

/**
 * PROTOTYPE — throwaway smoke/preview page (branch proto/logged-in-redesign).
 * Renders all three redesign variants stacked with demo data, so they can be
 * eyeballed in one scroll (and smoke-tested via SSR without a signed-in session).
 * Dev-only; renders nothing in production. Delete together with prototype-variants.tsx.
 */

import { PrototypeVariantView } from "../prototype-variants";

const label: React.CSSProperties = {
  margin: 0, padding: "14px 24px", background: "#111214", color: "#fff",
  fontFamily: "ui-monospace, Consolas, monospace", fontSize: 14,
};

export default function PrototypeSmokePage() {
  if (process.env.NODE_ENV === "production") return null;
  const noop = () => {};
  return (
    <div>
      <p style={label}>?variant=a — Operator (command rail). Interactive comparison: /account?variant=a</p>
      <PrototypeVariantView variant="a" setVariant={noop} data={null} />
      <p style={label}>?variant=b — Mission Control (dashboard)</p>
      <PrototypeVariantView variant="b" setVariant={noop} data={null} />
      <p style={label}>?variant=c — Correspondence (split-pane inbox)</p>
      <PrototypeVariantView variant="c" setVariant={noop} data={null} />
    </div>
  );
}
