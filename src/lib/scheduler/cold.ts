import { fetchAllESPN } from '../sources/espn';
import { fetchFotMob } from '../sources/fotmob';
import { upsertFixtureFromESPN, findFixtureByTeams, linkFotMobId } from '../db/fixtures';
import { upsertPollWindow } from '../db/poll-windows';
import { getSportForCompetition, queryAllSchemas, sportSchema } from '../db/schema';
import type { Sport } from '../types';

/**
 * Format date as YYYYMMDD for ESPN API.
 */
function formatDateESPN(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Format date as YYYY-MM-DD for FotMob API.
 */
function formatDateFotMob(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Cold sync: fetch fixtures for the next N days and upsert into correct sport schemas.
 * Also creates/updates poll windows for each fixture.
 */
export async function coldSync(daysAhead: number = 14): Promise<{
  fixturesSynced: number;
  fotmobLinked: number;
  windowsCreated: number;
}> {
  console.log(`[Cold Sync] Starting sync for next ${daysAhead} days...`);

  let fixturesSynced = 0;
  let fotmobLinked = 0;
  let windowsCreated = 0;

  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const espnDate = formatDateESPN(date);
    const fotmobDate = formatDateFotMob(date);

    console.log(`[Cold Sync] Fetching day ${espnDate}...`);

    // Fetch ESPN for this date
    const espnObs = await fetchAllESPN(espnDate);

    for (const obs of espnObs) {
      const scheduledStart = obs.scheduledStart.toISOString();
      const sport = getSportForCompetition(obs.competitionId);

      // Upsert into correct sport schema
      await upsertFixtureFromESPN(obs, scheduledStart);
      fixturesSynced++;

      // Create poll window in correct sport schema
      const fixtureId = `espn_${obs.espnEventId}`;
      await upsertPollWindow(fixtureId, scheduledStart, sport);
      windowsCreated++;
    }

    // Fetch FotMob for this date and try to link IDs (soccer only)
    const fotmobObs = await fetchFotMob(fotmobDate);
    for (const fObs of fotmobObs) {
      const sport = getSportForCompetition(fObs.competitionId);
      const match = await findFixtureByTeams(
        fObs.competitionId,
        fObs.homeTeam,
        fObs.awayTeam,
        fotmobDate,
      );
      if (match && fObs.fotmobMatchId && !match.fotmob_match_id) {
        await linkFotMobId(match.id, fObs.fotmobMatchId, sport);
        fotmobLinked++;
      }
    }

    if (dayOffset < daysAhead) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // ─── Stale status cleanup ───────────────────────────────────────────────
  // Any fixture stuck in a live status whose kickoff was 6+ hours ago is
  // definitely over. Force to full_time/final so nothing stays stuck
  // if the hot poll missed the ending (deployment, cron gap, etc.)
  const staleFixed = await fixStaleStatuses();

  console.log(
    `[Cold Sync] Done: ${fixturesSynced} fixtures synced, ${fotmobLinked} FotMob IDs linked, ${windowsCreated} poll windows, ${staleFixed} stale statuses fixed`,
  );

  return { fixturesSynced, fotmobLinked, windowsCreated };
}

/**
 * Fix fixtures stuck in live statuses that are clearly over.
 * A game scheduled 6+ hours ago that's still "live" is definitely finished.
 */
async function fixStaleStatuses(): Promise<number> {
  const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
  const liveStatuses = ['live_first_half', 'halftime', 'live_second_half', 'extra_time', 'in_progress'];

  // Soccer → full_time, basketball/baseball → final
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
