import { fetchAllESPN } from '../sources/espn';
import { fetchFotMob } from '../sources/fotmob';
import { getFixturesByESPNIdsAllSports } from '../db/fixtures';
import { insertObservation } from '../db/events';
import { getActiveFixtureIds, activateCurrentWindows, deactivateExpiredWindows } from '../db/poll-windows';
import { getSportForCompetition } from '../db/schema';
import { runConsensus, applyConsensus, matchFotMobObs } from '../consensus/engine';
import type { HotPollCycleResult } from '../types';

/**
 * Run a single hot poll cycle:
 * 1. Activate/deactivate poll windows (across all sport schemas)
 * 2. Fetch ESPN (all leagues, parallel) + FotMob (single call, soccer)
 * 3. For each active fixture, run consensus
 * 4. Apply results to correct sport schema
 */
export async function hotPollCycle(): Promise<HotPollCycleResult> {
  const cycleStart = Date.now();
  const errors: string[] = [];

  // Activate/deactivate windows across all schemas
  try {
    const activated = await activateCurrentWindows();
    const deactivated = await deactivateExpiredWindows();
    if (activated > 0) console.log(`[Hot] Activated ${activated} new windows`);
    if (deactivated > 0) console.log(`[Hot] Deactivated ${deactivated} expired windows`);
  } catch (err) {
    errors.push(`Window management: ${String(err)}`);
  }

  // Get active fixture IDs across all schemas
  const activeFixtureIds = await getActiveFixtureIds();
  if (activeFixtureIds.length === 0) {
    return {
      fixturesPolled: 0,
      eventsEmitted: 0,
      statusChanges: 0,
      espnLatencyMs: null,
      fotmobLatencyMs: null,
      espnObservations: 0,
      fotmobObservations: 0,
      activeFixtures: 0,
      errors,
    };
  }

  // Fetch from all sources in parallel
  const [espnObservations, fotmobObservations] = await Promise.all([
    fetchAllESPN().catch((err) => {
      errors.push(`ESPN fetch: ${String(err)}`);
      return [];
    }),
    fetchFotMob().catch((err) => {
      errors.push(`FotMob fetch: ${String(err)}`);
      return [];
    }),
  ]);

  // Compute max latencies
  const espnLatencyMs =
    espnObservations.length > 0
      ? Math.max(...espnObservations.map((o) => o.latencyMs))
      : null;
  const fotmobLatencyMs =
    fotmobObservations.length > 0
      ? Math.max(...fotmobObservations.map((o) => o.latencyMs))
      : null;

  const fetchElapsed = Date.now() - cycleStart;
  console.log(
    `[Hot] ${activeFixtureIds.length} fixtures | ${espnObservations.length} ESPN (${espnLatencyMs ?? 0}ms) + ${fotmobObservations.length} FotMob (${fotmobLatencyMs ?? 0}ms) fetched in ${fetchElapsed}ms`,
  );

  // Load active fixtures from DB (across all sport schemas)
  const espnIds = activeFixtureIds.map((id) => id.replace('espn_', '')).filter(Boolean);
  const fixtures = await getFixturesByESPNIdsAllSports(espnIds);

  // Build ESPN observation lookup by event ID
  const espnByEventId = new Map(
    espnObservations.filter((o) => o.espnEventId).map((o) => [o.espnEventId!, o]),
  );

  let eventsEmitted = 0;
  let statusChanges = 0;

  // Run consensus for each fixture (isolated per fixture)
  for (const fixture of fixtures) {
    try {
      const sport = getSportForCompetition(fixture.competition_id);
      const espnObs = fixture.espn_event_id
        ? espnByEventId.get(fixture.espn_event_id) ?? null
        : null;
      const isSoccer = sport === 'soccer';
      const fotmobObs = isSoccer ? matchFotMobObs(fixture, fotmobObservations) : null;

      // Store raw observations in correct sport schema
      if (espnObs) {
        await insertObservation(sport, {
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
        await insertObservation(sport, {
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

      // Consensus → apply to correct schema
      const result = runConsensus(fixture, espnObs, fotmobObs);

      if (
        result.statusUpdate ||
        result.scoreUpdate ||
        result.newEvents.length > 0 ||
        result.lifecycleEvents.length > 0
      ) {
        await applyConsensus(result);

        if (result.statusUpdate) statusChanges++;
        eventsEmitted += result.lifecycleEvents.length + result.newEvents.length;

        if (result.lifecycleEvents.length > 0) {
          console.log(
            `[Hot] [${sport}] ${fixture.home_team_name} vs ${fixture.away_team_name}: lifecycle [${result.lifecycleEvents.join(', ')}]`,
          );
        }
        if (result.newEvents.length > 0) {
          console.log(
            `[Hot] [${sport}] ${fixture.home_team_name} vs ${fixture.away_team_name}: ${result.newEvents.length} events`,
          );
        }
      }
    } catch (err) {
      const msg = `Fixture ${fixture.id} (${fixture.home_team_name} vs ${fixture.away_team_name}): ${String(err)}`;
      errors.push(msg);
      console.error(`[Hot] ${msg}`);
    }
  }

  const elapsed = Date.now() - cycleStart;
  console.log(
    `[Hot] Cycle done in ${elapsed}ms: ${fixtures.length} polled, ${statusChanges} status, ${eventsEmitted} events, ${errors.length} errors`,
  );

  return {
    fixturesPolled: fixtures.length,
    eventsEmitted,
    statusChanges,
    espnLatencyMs,
    fotmobLatencyMs,
    espnObservations: espnObservations.length,
    fotmobObservations: fotmobObservations.length,
    activeFixtures: activeFixtureIds.length,
    errors,
  };
}
