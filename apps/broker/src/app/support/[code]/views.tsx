/**
 * The views of /support/<code> (page.tsx loads the data): one uniform message for any code that can't be used,
 * one for "couldn't check right now", and the full page for a valid code. docs/remote-support.md.
 */
import type { SupportCodePage } from "@/lib/remote-support";
import { ReportButton } from "./report-button";

export function Invalid() {
  return (
    <div className="ds-card">
      <h1 className="ds-h1" style={{ fontSize: 20 }}>This code doesn&apos;t work</h1>
      <p style={{ lineHeight: 1.6 }}>
        It may have been mistyped, already used or cancelled, or it expired: codes work once, for 15 minutes.
        Ask the person helping you for a new one.
      </p>
      <p className="ds-fine" style={{ margin: 0 }}>If you didn&apos;t ask anyone for help, close this page. Nothing has happened on your computer.</p>
    </div>
  );
}

export function Unavailable() {
  return (
    <div className="ds-card">
      <p style={{ margin: 0, lineHeight: 1.6 }}>Couldn&apos;t check this code right now. Wait a minute and reload the page. Nothing has happened on your computer.</p>
    </div>
  );
}

export function Valid({ info, download }: { info: SupportCodePage; download: string | null }) {
  const { code } = info;
  const name = info.issuer.name;
  const who = name === info.issuer.handle ? name : `${name} (${info.issuer.handle})`;
  const minutesLeft = Math.max(1, Math.round((new Date(info.expiresAt).getTime() - Date.now()) / 60_000));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 className="ds-h1">{name} would like to help you</h1>
        <p className="ds-sub" style={{ margin: 0 }}>With one task on this computer, through Back Channel. Nothing happens until you say so.</p>
      </div>

      <div className="ds-card" style={{ borderColor: "#fdba74", background: "var(--ds-warn-soft)" }} role="note">
        <div className="ds-cardh" style={{ color: "var(--ds-warn)" }}>Only continue if you personally asked {name} for help.</div>
        <p style={{ margin: "6px 0 0", lineHeight: 1.6, fontSize: 14 }}>
          Back Channel, Microsoft, Apple, your bank and other companies will never send you a code like this, or call you about one.
          If someone you don&apos;t know gave you this code, or anyone is rushing you, stop here and use the button at the bottom of this page.
        </p>
      </div>

      <div className="ds-card">
        <div className="ds-cardh">Who is asking</div>
        <p style={{ margin: "4px 0 2px", fontSize: 16, fontWeight: 600 }}>{who}</p>
        <p className="ds-fine" style={{ margin: 0 }}>This is the name on their Back Channel account. They didn&apos;t type it for this code.</p>
        <div className="ds-cardh" style={{ marginTop: 16 }}>What for</div>
        <p style={{ margin: "4px 0 2px", fontSize: 15, lineHeight: 1.5, overflowWrap: "anywhere" }}>&ldquo;{info.task}&rdquo;</p>
        <p className="ds-fine" style={{ margin: 0 }}>For up to {info.minutes} minutes once you allow it. Then it ends on its own.</p>
      </div>

      <div className="ds-card">
        <div className="ds-cardh">How it works</div>
        <ol style={{ margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.7, fontSize: 14 }}>
          <li>Download the helper and open it.</li>
          <li>If it asks for a code, enter: <span className="ds-mono" style={{ fontWeight: 600, userSelect: "all" }}>{code}</span></li>
          <li>Check that it shows {name} and the same task, then press <b>Allow</b>.</li>
          <li>{name}&apos;s AI assistant asks you before every change. You can say no to any of them, and press <b>Stop</b> at any time.</li>
          <li>When it&apos;s done, it disconnects and shows you a short summary of what was done. It never installed anything; you can then delete the file you downloaded.</li>
        </ol>
        <div style={{ marginTop: 16 }}>
          {download ? (
            <>
              {/* The helper reads its code from this file name, so the person needn't type it. Browsers honour the name only
                  for a same-origin download; otherwise the helper asks for the code (step 2). */}
              <a className="ds-btn" style={{ textDecoration: "none", display: "inline-block" }} href={download} download={`BackChannelHelp-${code}.exe`} rel="noopener noreferrer">Download the helper</a>
              <p className="ds-fine" style={{ margin: "8px 0 0" }}>For Windows. It doesn&apos;t install anything and can&apos;t do anything until you press Allow.</p>
            </>
          ) : (
            <div style={{ border: "1px dashed var(--ds-line)", borderRadius: 8, padding: "12px 14px" }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>The helper isn&apos;t available yet.</p>
              <p className="ds-fine" style={{ margin: "4px 0 0" }}>
                It needs a security signature that Back Channel is still getting, so there is nothing to download yet. Nothing has happened on your computer,
                and this code will expire on its own. Let {name} know.
              </p>
            </div>
          )}
        </div>
        <p className="ds-fine" style={{ margin: "12px 0 0" }}>This code works once. It expires in about {minutesLeft} minute{minutesLeft === 1 ? "" : "s"}.</p>
      </div>

      <div className="ds-card">
        <div className="ds-cardh">Didn&apos;t ask for this?</div>
        <p className="ds-cardsub">The code stops working straight away, nothing happens on your computer, and {name} can see that you reported it.</p>
        <ReportButton code={code} />
      </div>
    </div>
  );
}
