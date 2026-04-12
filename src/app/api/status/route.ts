import { NextResponse } from 'next/server';
import { queryAllSchemas } from '@/lib/db/schema';
import { getRecentPollLogs, getPollHealthStats } from '@/lib/db/poll-logs';

export const dynamic = 'force-dynamic';

/**
 * Health check / status endpoint.
 * Queries all sport schemas (soccer, basketball, baseball) and merges results.
 */
export async function GET() {
  try {
    const now = new Date().toISOString();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();

    // Cross-schema queries
    const [
      allFixtures,
      activeWindows,
      recentEvents,
      eventsLastHour,
      pollHealth,
      recentCycles,
    ] = await Promise.all([
      // All fixtures (status only) across schemas
      queryAllSchemas((schema) =>
        schema.from('fixtures').select('status, competition_id').not('status', 'is', null),
      ),
      // Active windows across schemas
      queryAllSchemas((schema) =>
        schema
          .from('poll_windows')
          .select('id')
          .lte('window_start', now)
          .gte('window_end', now),
      ),
      // Recent events across schemas
      queryAllSchemas((schema) =>
        schema
          .from('match_events')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(5),
      ),
      // Events last hour across schemas
      queryAllSchemas((schema) =>
        schema
          .from('match_events')
          .select('id')
          .gte('created_at', oneHourAgo),
      ),
      // Poll health (from public schema)
      getPollHealthStats(oneHourAgo),
      // Recent cycles (from public schema)
      getRecentPollLogs(20),
    ]);

    // Count fixtures by status
    const statusCounts: Record<string, number> = {};
    for (const f of allFixtures) {
      statusCounts[f.status] = (statusCounts[f.status] ?? 0) + 1;
    }

    // Count fixtures by sport
    const sportCounts: Record<string, number> = {};
    for (const f of allFixtures) {
      const comp = f.competition_id;
      const sport = ['nba'].includes(comp) ? 'basketball' : ['mlb'].includes(comp) ? 'baseball' : 'soccer';
      sportCounts[sport] = (sportCounts[sport] ?? 0) + 1;
    }

    // Sort recent events by created_at desc (merged from multiple schemas)
    recentEvents.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    return NextResponse.json({
      status: 'ok',
      timestamp: now,
      totalFixtures: allFixtures.length,
      fixturesByStatus: statusCounts,
      fixturesBySport: sportCounts,
      activeWindows: activeWindows.length,
      eventsLastHour: eventsLastHour.length,
      recentEvents: recentEvents.slice(0, 10),
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
