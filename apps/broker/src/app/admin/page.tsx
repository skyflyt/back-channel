import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { checkOwnerAdmin } from "@/lib/admin";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { AdminDashboard } from "./admin-dashboard";
import "@/components/ui/theme.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Back Channel", robots: { index: false, follow: false } };

/**
 * /admin — checked on the server before anything renders (src/lib/admin.ts).
 * Signed out: a generic sign-in prompt that does not mention admin. Signed in
 * but not the owner: a plain 404, so the page does not confirm that an admin
 * area exists. The owner gets the dashboard, whose API calls are each checked
 * again on the server.
 */
export default async function AdminPage() {
  const [jar, hdrs] = await Promise.all([cookies(), headers()]);
  const gate = await checkOwnerAdmin({ authorization: hdrs.get("authorization"), sessionCookie: jar.get(SESSION_COOKIE_NAME)?.value }, false);
  if (!gate.ok && gate.status === 401) {
    return (
      <div className="ds-root">
        <div className="ds-wrap" style={{ maxWidth: 480 }}>
          <div className="ds-card">
            <p style={{ margin: "0 0 12px" }}>Sign in to continue.</p>
            <a className="ds-btn" style={{ textDecoration: "none", display: "inline-block" }} href="/login">Sign in</a>
          </div>
        </div>
      </div>
    );
  }
  if (!gate.ok) notFound();
  return <AdminDashboard />;
}
