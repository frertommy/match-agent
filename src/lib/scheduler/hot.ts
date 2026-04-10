import { fetchAllESPN } from '../sources/espn';
import { fetchFotMob } from '../sources/fotmob';
import { getFixturesByESPNIds } from '../db/fixtures';
import { insertObservation } from '../db/events';
import { getActiveFixtureIds, activateCurrentWindows, deactivateExpiredWindows } from '../db/poll-windows';
import { runConsensus, applyConsensus, matchFotMobObs } from '../consensus/engine';
import { supabase } from '../db/client';
import type { Fixture, NormalizedObservation } from '../types';

/**
 * Run a single hot poll cycle:
 * 1. Fetch ESPN (all leagues, parallel)
 * 2. Fetch FotMob (single call, soccer)
 * 3. For each active fixture, run consensus
 * 4. Apply results to DB
 */
export async function hotPollCycle(): Promise<{
  fixturesPolled: number;
  eventsEmitted: number;
  statusChanges: number;
}> {
  const cycleStart = Date.now();

  // Activate/deactivate windows
  const activated = await activateCurrentWindows();
  const deactivated = await deactivateExpiredWindows();

  if (activated > 0) console.log(`[Hot] Activated ${activated} new windows`);
  if (deactivated > 0) console.log(`[Hot] Deactivated ${deactivated} expired windows`);

  // Get active fixture IDs
  const activeFixtureIds = await getActiveFixtureIds();
  if (activeFixtureIds.length === 0) {
    console.log('[Hot] No active windows — skipping poll cycle');
    return { fixturesPolled: 0, eventsEmitted: 0, statusChanges: 0 };
  }

  console.log(`[Hot] ${activeFixtureIds.length} active fixtures — starting poll...`);

  // Fetch from all sources in parallel
  const [espnObservations, fotmobObservations] = await Promise.all([
    fetchAllESPN(),
    fetchFotMob(),
  ]);

  console.log(
    `[Hot] Fetched ${espnObservations.length} ESPN obs, ${fotmobObservations.length} FotMob obs in ${Date.now() - cycleStart}ms`,
  );

  // Load active fixtures from DB
  const espnIds = activeFixtureIds
    .map((id) => id.replace('espn_', ''))
    .filter(Boolean);
  const fixtures = await getFixturesByESPNIds(espnIds);

  // Build ESPN observation lookup by event ID
  const espnByEventId = new Map<string, NormalizedObservation>();
  for (const obs of espnObservations) {
    if (obs.espnEventId) espnByEventId.set(obs.espnEventId, obs);
  }

  let eventsEmitted = 0;
  let statusChanges = 0;

  // Run consensus for each fixture
  for (const fixture of fixtures) {
    const espnObs = fixture.espn_event_id ? espnByEventId.get(fixture.espn_event_id) ?? null : null;
    const isSoccer = !['nba', 'mlb'].includes(fixture.competition_id);
    const fotmobObs = isSoccer ? matchFotMobObs(fixture, fotmobObservations) : null;

    // Store raw observations for audit
    if (espnObs) {
      await insertObservation({
        fixture_id: fixture.id,
        source: 'espn',
        observed_status: espnObs.status,
        observed_home_score: espnObs.homeScore,
        observed_away_score: espnObs.awayScore,
        observed_events: espnObs.events,
        observed_at: espnObs.observedAt.toISOString(),
        latency_ms: espnObs.latencyMs,
      });
    }
    if (fotmobObs) {
      await insertObservation({
        fixture_id: fixture.id,
        source: 'fotmob',
        observed_status: fotmobObs.status,
        observed_home_score: fotmobObs.homeScore,
        observed_away_score: fotmobObs.awayScore,
        observed_events: null,
        observed_at: fotmobObs.observedAt.toISOString(),
        latency_ms: fotmobObs.latencyMs,
      });
    }

    // Run consensus
    const result = runConsensus(fixture, espnObs, fotmobObs);

    // Apply to DB
    if (result.statusUpdate || result.scoreUpdate || result.newEvents.length > 0 || result.lifecycleEvents.length > 0) {
      await applyConsensus(result);

      if (result.statusUpdate) statusChanges++;
      eventsEmitted += result.lifecycleEvents.length + result.newEvents.length;

      if (result.lifecycleEvents.length > 0) {
        console.log(
          `[Hot] ${fixture.home_team_name} vs ${fixture.away_team_name}: lifecycle [${result.lifecycleEvents.join(', ')}]`,
        );
      }
      if (result.newEvents.length > 0) {
        console.log(
          `[Hot] ${fixture.home_team_name} vs ${fixture.away_team_name}: ${result.newEvents.length} events`,
        );
      }
    }
  }

  const elapsed = Date.now() - cycleStart;
  console.log(
    `[Hot] Cycle complete in ${elapsed}ms: ${fixtures.length} fixtures polled, ${statusChanges} status changes, ${eventsEmitted} events emitted`,
  );

  return { fixturesPolled: fixtures.length, eventsEmitted, statusChanges };
}
