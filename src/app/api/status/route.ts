import { NextResponse } from 'next/server';
import { supabase } from '@/lib/db/client';
import { getRecentPollLogs, getPollHealthStats } from '@/lib/db/poll-logs';

export const dynamic = 'force-dynamic';

/**
 * Health check / status endpoint.
 * Returns overview of fixtures, active windows, poll health metrics, and recent events.
 */
export async function GET() {
  try {
    const now = new Date().toISOString();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();

    // Run queries in parallel
    const [
      fixturesResult,
      activeWindowsResult,
      recentEventsResult,
      totalFixturesResult,
      eventsLastHourResult,
      pollHealth,
      recentCycles,
    ] = await Promise.all([
      // Fixtures by status
      supabase.from('fixtures').select('status').not('status', 'is', null),
      // Active windows
      supabase
        .from('poll_windows')
        .select('id')
        .lte('window_start', now)
        .gte('window_end', now),
      // Recent events
      supabase
        .from('match_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10),
      // Total fixtures
      supabase.from('fixtures').select('id', { count: 'exact', head: true }),
      // Events in last hour
      supabase
        .from('match_events')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', oneHourAgo),
      // Poll health stats (last hour)
      getPollHealthStats(oneHourAgo),
      // Recent poll cycle logs
      getRecentPollLogs(20),
    ]);

    // Count fixtures by status
    const statusCounts: Record<string, number> = {};
    for (const f of fixturesResult.data ?? []) {
      statusCounts[f.status] = (statusCounts[f.status] ?? 0) + 1;
    }

    return NextResponse.json({
      status: 'ok',
      timestamp: now,
      totalFixtures: totalFixturesResult.count ?? 0,
      fixturesByStatus: statusCounts,
      activeWindows: activeWindowsResult.data?.length ?? 0,
      eventsLastHour: eventsLastHourResult.count ?? 0,
      recentEvents: recentEventsResult.data ?? [],
      pollHealth,
      recentCycles,
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', error: String(error) },
      { status: 500 },
    );
  }
}
