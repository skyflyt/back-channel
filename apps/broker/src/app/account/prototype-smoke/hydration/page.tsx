import { notFound } from "next/navigation";
import HydrationCanary from "./canary";

/**
 * Hydration canary (docs/logged-in-redesign.md § The server.mjs hydration question). It exists
 * to prove React commits under the custom server, so it stays; but it is a dev page, not a
 * public one, so production answers 404.
 */
export default function HydrationCanaryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <HydrationCanary />;
}
