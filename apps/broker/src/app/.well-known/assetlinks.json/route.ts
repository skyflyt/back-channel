import { NextResponse } from "next/server";
import { assetLinks } from "@/lib/android-app";

// Digital Asset Links: lets the BC Remote app use back-channel.app passkeys (src/lib/android-app.ts).
export const dynamic = "force-static";
export const GET = () => NextResponse.json(assetLinks(), { headers: { "Cache-Control": "public, max-age=3600" } });
