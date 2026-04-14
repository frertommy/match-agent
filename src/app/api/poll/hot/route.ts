import { NextResponse } from 'next/server';
import { hotPollCycle } from '@/lib/scheduler/hot';
import { insertPollCycleLog } from '@/lib/db/poll-logs';
import type { HotPollCycleResult } from '@/lib/types';

export const maxDuration = 300; // 5 min safety net (Vercel Pro + Fluid Compute)
export const dynamic = 'force-dynamic';

const LOOP_DURATION_MS = 55_000; // exit after ~55 seconds
const POLL_INTERVAL_MS = 2_000; // ~2 seconds between iterations

/**
 * Hot poll endpoint: triggered by check-windows cron.
 * Loops for ~55 seconds, polling every ~4s for sub-5s event detection.
 * Each iteration is logged to poll_cycle_logs for later analysis.
 */
export async function POST(request: Request) {
  // Verify secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const invocationId = crypto.randomUUID();
  const loopStart = Date.now();
  let iteration = 0;
  let totalEvents = 0;
  let totalStatusChanges = 0;

  console.log(`[Hot Loop] Starting invocation ${invocationId.slice(0, 8)}...`);

  try {
    while (Date.now() - loopStart < LOOP_DURATION_MS) {
      const iterStart = Date.now();

      const result = await hotPollCycle();

      const iterEnd = Date.now();
      const durationMs = iterEnd - iterStart;

      // Log this iteration to DB (fire-and-forget to not slow the loop)
      insertPollCycleLog({
        invocation_id: invocationId,
        iteration,
        started_at: new Date(iterStart).toISOString(),
        ended_at: new Date(iterEnd).toISOString(),
        duration_ms: durationMs,
        fixtures_polled: result.fixturesPolled,
        events_emitted: result.eventsEmitted,
        status_changes: result.statusChanges,
        espn_latency_ms: result.espnLatencyMs,
        fotmob_latency_ms: result.fotmobLatencyMs,
        espn_observations: result.espnObservations,
        fotmob_observations: result.fotmobObservations,
        active_fixtures: result.activeFixtures,
        errors: result.errors,
      }).catch((err) => console.error('[Hot Loop] Log write failed:', err));

      totalEvents += result.eventsEmitted;
      totalStatusChanges += result.statusChanges;

      // If no active fixtures, exit immediately (don't burn compute for nothing)
      if (result.activeFixtures === 0) {
        console.log(`[Hot Loop] No active fixtures at iteration ${iteration} — exiting`);
        break;
      }

      iteration++;

      // Sleep until next interval (subtract time already spent on this cycle)
      const elapsed = Date.now() - iterStart;
      const sleepMs = Math.max(0, POLL_INTERVAL_MS - elapsed);

      // Check if sleeping would push us past the loop deadline
      if (Date.now() + sleepMs - loopStart >= LOOP_DURATION_MS) break;

      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }
  } catch (error) {
    console.error('[Hot Loop] Fatal error:', error);
  }

  const totalDuration = Date.now() - loopStart;
  console.log(
    `[Hot Loop] Done: ${iteration} iterations in ${totalDuration}ms | ${totalEvents} events, ${totalStatusChanges} status changes`,
  );

  return NextResponse.json({
    success: true,
    invocationId,
    iterations: iteration,
    totalDurationMs: totalDuration,
    totalEventsEmitted: totalEvents,
    totalStatusChanges,
    timestamp: new Date().toISOString(),
  });
}
