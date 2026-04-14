import { NextResponse } from 'next/server';
import { getActiveWindows, activateCurrentWindows, deactivateExpiredWindows } from '@/lib/db/poll-windows';
import { hotPollCycle } from '@/lib/scheduler/hot';
import { insertPollCycleLog } from '@/lib/db/poll-logs';

export const maxDuration = 300; // 5 min safety net (Fluid Compute)
export const dynamic = 'force-dynamic';

const LOOP_DURATION_MS = 55_000; // exit after ~55 seconds
const POLL_INTERVAL_MS = 2_000; // ~2 seconds between iterations

/**
 * Vercel Cron: runs every 1 minute.
 * If active poll windows exist, runs the hot poll loop inline (~55s, ~13 iterations).
 * No HTTP hop — calls hotPollCycle() directly to avoid fire-and-forget issues.
 */
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Activate/deactivate windows
    const activated = await activateCurrentWindows();
    const deactivated = await deactivateExpiredWindows();
    const activeWindows = await getActiveWindows();

    if (activeWindows.length === 0) {
      return NextResponse.json({
        success: true,
        active: false,
        message: 'No active windows',
        activated,
        deactivated,
        timestamp: new Date().toISOString(),
      });
    }

    // ─── Hot Poll Loop (inline) ──────────────────────────────────────────
    const invocationId = crypto.randomUUID();
    const loopStart = Date.now();
    let iteration = 0;
    let totalEvents = 0;
    let totalStatusChanges = 0;

    console.log(`[Cron→Hot] Starting invocation ${invocationId.slice(0, 8)} with ${activeWindows.length} active windows...`);

    while (Date.now() - loopStart < LOOP_DURATION_MS) {
      const iterStart = Date.now();

      const result = await hotPollCycle();

      const iterEnd = Date.now();
      const durationMs = iterEnd - iterStart;

      // Log iteration (fire-and-forget is fine here since we're still in the loop)
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
      }).catch((err) => console.error('[Cron→Hot] Log write failed:', err));

      totalEvents += result.eventsEmitted;
      totalStatusChanges += result.statusChanges;

      // If no active fixtures, exit immediately (don't burn compute for nothing)
      if (result.activeFixtures === 0) {
        console.log(`[Cron→Hot] No active fixtures at iteration ${iteration} — exiting`);
        break;
      }

      iteration++;

      // Sleep until next interval
      const elapsed = Date.now() - iterStart;
      const sleepMs = Math.max(0, POLL_INTERVAL_MS - elapsed);

      if (Date.now() + sleepMs - loopStart >= LOOP_DURATION_MS) break;

      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    const totalDuration = Date.now() - loopStart;
    console.log(
      `[Cron→Hot] Done: ${iteration} iterations in ${totalDuration}ms | ${totalEvents} events, ${totalStatusChanges} status changes`,
    );

    return NextResponse.json({
      success: true,
      active: true,
      activeWindows: activeWindows.length,
      activated,
      deactivated,
      invocationId,
      iterations: iteration,
      totalDurationMs: totalDuration,
      totalEventsEmitted: totalEvents,
      totalStatusChanges,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}
