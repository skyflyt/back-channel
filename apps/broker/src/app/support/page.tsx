import type { Metadata } from "next";
import { CodeForm } from "./code-form";
import "@/components/ui/theme.css";

export const metadata: Metadata = { title: "Enter a support code", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * /support: type the code you were sent (BCS-XXXX-XXXX) and see who it's from (docs/remote-support.md). It only
 * leads to /support/<code>, which does the checking; nothing is looked up here.
 */
export default function SupportEntryPage() {
  return (
    <div className="ds-root" style={{ minHeight: "100vh" }}>
      <div className="ds-wrap" style={{ maxWidth: 520 }}>
        <div className="ds-fine" style={{ marginBottom: 16, fontWeight: 600 }}>Back Channel</div>
        <div className="ds-card">
          <h1 className="ds-h1" style={{ fontSize: 20 }}>Enter your support code</h1>
          <p className="ds-cardsub">Someone you asked for help sent you a code that starts with BCS. Type it here to see who it&apos;s from and what it&apos;s for. Nothing happens on your computer yet.</p>
          <CodeForm />
          <p className="ds-fine" style={{ margin: "14px 0 0" }}>Only use a code from someone you personally asked for help. No company will ever send you one.</p>
        </div>
      </div>
    </div>
  );
}
