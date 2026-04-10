import { NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

/**
 * Health check / status endpoint.
 * Returns overview of fixtures and active windows.
 */
export async function GET() {
  try {
    const now = new Date().toISOString();

    // Count fixtures by status
    const { data: fixtures } = await supabase
      .from('fixtures')
      .select('status')
      .not('status', 'is', null);

    const statusCounts: Record<string, number> = {};
    for (const f of fixtures ?? []) {
      statusCounts[f.status] = (statusCounts[f.status] ?? 0) + 1;
    }

    // Count active windows
    const { data: activeWindows } = await supabase
      .from('poll_windows')
      .select('id')
      .lte('window_start', now)
      .gte('window_end', now);

    // Recent events
    const { data: recentEvents } = await supabase
      .from('match_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    // Total fixtures
    const { count: totalFixtures } = await supabase
      .from('fixtures')
      .select('id', { count: 'exact', head: true });

    return NextResponse.json({
      status: 'ok',
      timestamp: now,
      totalFixtures,
      fixturesByStatus: statusCounts,
      activeWindows: activeWindows?.length ?? 0,
      recentEvents: recentEvents ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', error: String(error) },
      { status: 500 },
    );
  }
}
