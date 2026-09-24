import { NextResponse } from "next/server";
import { LANGUAGES, VOICES } from "@/lib/voices";

export const runtime = "nodejs";

/** GET /api/voices — static neural voice catalog (30+ languages, 60+ voices) */
export async function GET() {
  return NextResponse.json(
    { languages: LANGUAGES, voices: VOICES },
    { headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
