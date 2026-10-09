import type { Metadata } from "next";
import { supportClientUrl, supportCodeForPage, type SupportCodePage } from "@/lib/remote-support";
import { Invalid, Unavailable, Valid } from "./views";
import "@/components/ui/theme.css";

export const dynamic = "force-dynamic";
// Never indexed, and the code in this address never leaves in a Referer (the download link included).
export const metadata: Metadata = { title: "Help from someone you know", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * /support/<code>: what the person being helped sees when they open the link they were sent (docs/remote-support.md).
 *
 * It says plainly who is asking (the issuer's Back Channel account, as the broker asserts it, never text typed for
 * this code) and for what, warns about tech-support scams, offers the helper download, and an "I didn't ask for
 * this" button that cancels the code and tells the issuer. A code that can't be used right now (unknown, mistyped,
 * used, cancelled, reported or expired) gets one uniform message: the page never says which.
 *
 * The helper is not published yet: it needs a publicly trusted code signature. The download reads
 * SUPPORT_CLIENT_URL (https only), set by Skylar once a signed build exists; until then the page says so honestly
 * and links nothing.
 */
export default async function SupportCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  let code = raw;
  try { code = decodeURIComponent(raw); } catch { /* the lookup refuses it */ }
  let info: SupportCodePage | null = null;
  let failed = false;
  try { info = await supportCodeForPage(code); } catch { failed = true; }
  return (
    <div className="ds-root" style={{ minHeight: "100vh" }}>
      <div className="ds-wrap" style={{ maxWidth: 600 }}>
        <div className="ds-fine" style={{ marginBottom: 16, fontWeight: 600 }}>Back Channel</div>
        {failed ? <Unavailable /> : info ? <Valid info={info} download={supportClientUrl()} /> : <Invalid />}
      </div>
    </div>
  );
}
