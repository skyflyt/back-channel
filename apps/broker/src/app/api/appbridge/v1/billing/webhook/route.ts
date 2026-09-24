import { NextRequest } from "next/server";
import { stripeWebhook } from "@/lib/billing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stripe only: authenticated by the Stripe-Signature header over the raw body. No cookie, no CSRF.
export const POST = (req: NextRequest) => stripeWebhook(req);
