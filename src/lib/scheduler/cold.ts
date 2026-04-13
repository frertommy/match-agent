import { fetchAllESPN } from '../sources/espn';
import { fetchFotMob } from '../sources/fotmob';
import { upsertFixtureFromESPN, linkFotMobId } from '../db/fixtures';
import { upsertPollWindow } from '../db/poll-windows';
import { getSportForCompetition, queryAllSchemas, sportSchema } from '../db/schema';
import { fetchMsiFixtures, getMsiLeague } from '../db/msi-client';
import { resolveFixtureLinks } from '../matching/resolve';
import type { Sport, SourceCandidate, NormalizedObservation } from '../types';

function formatDateESPN(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function formatDateISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Cold sync: fetch fixtures, match across sources (ESPN ↔ FotMob ↔ API-Football),
 * create poll windows, clean up stale statuses.
 */
export async function coldSync(daysAhead: number = 14): Promise<{
  fixturesSynced: number;
  fotmobLinked: number;
  msiLinked: number;
  windowsCreated: number;
}> {
  console.log(`[Cold Sync] Starting sync for next ${daysAhead} days...`);

  let fixturesSynced = 0;
  let fotmobLinked = 0;
  let msiLinked = 0;
  let windowsCreated = 0;

  // Collect ESPN observations per day for matching
  const dailyEspnObs: Map<string, NormalizedObservation[]> = new Map();

  // ─── Phase 1: Upsert ESPN fixtures + poll windows ──────────────────────
  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const espnDate = formatDateESPN(date);
    const isoDate = formatDateISO(date);

    console.log(`[Cold Sync] Fetching day ${espnDate}...`);

    const espnObs = await fetchAllESPN(espnDate);
    dailyEspnObs.set(isoDate, espnObs);

    for (const obs of espnObs) {
      const scheduledStart = obs.scheduledStart.toISOString();
      const sport = getSportForCompetition(obs.competitionId);

      await upsertFixtureFromESPN(obs, scheduledStart);
      fixturesSynced++;

      const fixtureId = `espn_${obs.espnEventId}`;
      await upsertPollWindow(fixtureId, scheduledStart, sport);
      windowsCreated++;
    }

    if (dayOffset < daysAhead) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // ─── Phase 2: Cross-source matching ────────────────────────────────────
  console.log('[Cold Sync] Starting cross-source matching...');

  for (const [isoDate, espnObs] of dailyEspnObs) {
    // Only match soccer fixtures (MSI + FotMob are soccer-only)
    const soccerObs = espnObs.filter(
      (o) => getSportForCompetition(o.competitionId) === 'soccer',
    );
    if (soccerObs.length === 0) continue;

    // Build ESPN fixture list for matching
    const espnForMatching = soccerObs.map((o) => ({
      id: `espn_${o.espnEventId}`,
      competitionId: o.competitionId,
      homeTeam: o.homeTeam,
      awayTeam: o.awayTeam,
      scheduledStart: o.scheduledStart.toISOString(),
    }));

    // ── Match ESPN ↔ API-Football (MSI) ──
    try {
      // Fetch MSI fixtures for this date (all soccer leagues)
      const competitions = [...new Set(soccerObs.map((o) => o.competitionId))];
      const msiFixtures: SourceCandidate[] = [];

      for (const compId of competitions) {
        const msi = await fetchMsiFixtures(isoDate, compId);
        for (const m of msi) {
          msiFixtures.push({
            source: 'api_football',
            id: m.fixture_id,
            homeTeam: m.home_team,
            awayTeam: m.away_team,
            scheduledStart: m.commence_time,
          });
        }
      }

      if (msiFixtures.length > 0) {
        const msiStats = await resolveFixtureLinks(espnForMatching, 'api_football', msiFixtures);
        msiLinked += msiStats.exact + msiStats.alias + msiStats.ai;
      }
    } catch (err) {
      console.error(`[Cold Sync] MSI matching failed for ${isoDate}:`, err);
    }

    // ── Match ESPN ↔ FotMob ──
    try {
      const fotmobObs = await fetchFotMob(isoDate);
      const fotmobCandidates: SourceCandidate[] = fotmobObs.map((o) => ({
        source: 'fotmob' as const,
        id: o.fotmobMatchId!,
        homeTeam: o.homeTeam,
        awayTeam: o.awayTeam,
        scheduledStart: o.scheduledStart.toISOString(),
      })).filter((c) => c.id != null);

      if (fotmobCandidates.length > 0) {
        const fmStats = await resolveFixtureLinks(espnForMatching, 'fotmob', fotmobCandidates);
        fotmobLinked += fmStats.exact + fmStats.alias + fmStats.ai;

        // Backward compat: also set fotmob_match_id on soccer.fixtures
        for (const cand of fotmobCandidates) {
          // Find the ESPN fixture that matched this FotMob candidate
          const espn = espnForMatching.find((e) =>
            e.homeTeam === cand.homeTeam && e.awayTeam === cand.awayTeam,
          );
          // If not exact, the fixture_links table has the mapping
        }
      }
    } catch (err) {
      console.error(`[Cold Sync] FotMob matching failed for ${isoDate}:`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // ─── Phase 3: Stale status cleanup ─────────────────────────────────────
  const staleFixed = await fixStaleStatuses();

  console.log(
    `[Cold Sync] Done: ${fixturesSynced} synced, ${msiLinked} MSI linked, ${fotmobLinked} FotMob linked, ${windowsCreated} windows, ${staleFixed} stale fixed`,
  );

  return { fixturesSynced, fotmobLinked, msiLinked, windowsCreated };
}

async function fixStaleStatuses(): Promise<number> {
  const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
  const liveStatuses = ['live_first_half', 'halftime', 'live_second_half', 'extra_time', 'in_progress'];

  const sportTerminal: Record<string, string> = {
    soccer: 'full_time',
    basketball: 'final',
    baseball: 'final',
  };

  let total = 0;
  for (const [sport, terminalStatus] of Object.entries(sportTerminal)) {
    const { data, error } = await sportSchema(sport as Sport)
      .from('fixtures')
      .update({ status: terminalStatus, updated_at: new Date().toISOString() })
      .in('status', liveStatuses)
      .lt('scheduled_start', sixHoursAgo)
      .select('id, home_team_name, away_team_name, status');

    if (error) {
      console.error(`[Cold Sync] Stale fix failed for ${sport}:`, error.message);
      continue;
    }

    if (data && data.length > 0) {
      for (const f of data) {
        console.log(`[Cold Sync] Fixed stale: ${f.home_team_name} vs ${f.away_team_name} → ${terminalStatus}`);
      }
      total += data.length;
    }
  }

  return total;
}
