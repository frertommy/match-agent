import { fetchAllESPN } from '../sources/espn';
import { fetchFotMob } from '../sources/fotmob';
import { upsertFixtureFromESPN, findFixtureByTeams, linkFotMobId } from '../db/fixtures';
import { upsertPollWindow } from '../db/poll-windows';
import { supabase } from '../db/client';
import type { Competition } from '../types';

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
 * Get competition sport mapping.
 */
async function getCompetitionSports(): Promise<Record<string, string>> {
  const { data } = await supabase.from('competitions').select('id, sport');
  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    map[row.id] = row.sport;
  }
  return map;
}

/**
 * Cold sync: fetch fixtures for the next N days and upsert into DB.
 * Also creates/updates poll windows for each fixture.
 */
export async function coldSync(daysAhead: number = 14): Promise<{
  fixturesSynced: number;
  fotmobLinked: number;
  windowsCreated: number;
}> {
  console.log(`[Cold Sync] Starting sync for next ${daysAhead} days...`);

  const sportMap = await getCompetitionSports();
  let fixturesSynced = 0;
  let fotmobLinked = 0;
  let windowsCreated = 0;

  // Iterate each day
  for (let dayOffset = 0; dayOffset <= daysAhead; dayOffset++) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const espnDate = formatDateESPN(date);
    const fotmobDate = formatDateFotMob(date);

    console.log(`[Cold Sync] Fetching day ${espnDate}...`);

    // Fetch ESPN for this date
    const espnObs = await fetchAllESPN(espnDate);

    for (const obs of espnObs) {
      // Derive scheduled_start from the ESPN event date
      const scheduledStart = obs.observedAt.toISOString();

      await upsertFixtureFromESPN(obs, scheduledStart);
      fixturesSynced++;

      // Create poll window
      const sport = sportMap[obs.competitionId] ?? 'soccer';
      const fixtureId = `espn_${obs.espnEventId}`;
      await upsertPollWindow(fixtureId, scheduledStart, sport);
      windowsCreated++;
    }

    // Fetch FotMob for this date and try to link IDs
    const fotmobObs = await fetchFotMob(fotmobDate);
    for (const fObs of fotmobObs) {
      const match = await findFixtureByTeams(
        fObs.competitionId,
        fObs.homeTeam,
        fObs.awayTeam,
        fotmobDate,
      );
      if (match && fObs.fotmobMatchId && !match.fotmob_match_id) {
        await linkFotMobId(match.id, fObs.fotmobMatchId);
        fotmobLinked++;
      }
    }

    // Small delay between days to avoid hammering
    if (dayOffset < daysAhead) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.log(
    `[Cold Sync] Done: ${fixturesSynced} fixtures synced, ${fotmobLinked} FotMob IDs linked, ${windowsCreated} poll windows`,
  );

  return { fixturesSynced, fotmobLinked, windowsCreated };
}
