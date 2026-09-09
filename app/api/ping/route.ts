/**
 * Liveness probe for the offline network monitor (lib/offline/network.ts).
 * No auth, no data — a completed HTTP response is all the monitor needs.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return new NextResponse(null, { status: 204 })
}
