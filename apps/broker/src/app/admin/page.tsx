import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { checkOwnerAdmin } from "@/lib/admin";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { AdminDashboard } from "./admin-dashboard";
import "@/components/ui/theme.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Back Channel", robots: { index: false, follow: false } };

/**
 * /admin — the owner's dashboard. Anyone else never gets this far: src/proxy.ts
 * runs the same check before the page is chosen and answers them exactly as it
 * would a URL that does not exist. The check here is the second lock, for the
 * day the proxy's matcher or a rewrite rule stops covering this path. It gives
 * a 404 to everyone who is not the owner, signed out included: there is no
 * sign-in prompt, because a prompt at /admin says there is something to sign
 * in to. The dashboard's API calls are each checked again on the server.
 */
export default async function AdminPage() {
  const [jar, hdrs] = await Promise.all([cookies(), headers()]);
  const gate = await checkOwnerAdmin({ authorization: hdrs.get("authorization"), sessionCookie: jar.get(SESSION_COOKIE_NAME)?.value }, false);
  if (!gate.ok) notFound();
  return <AdminDashboard />;
}
