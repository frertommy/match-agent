import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { MsiFixture } from '../types';

let _msiClient: SupabaseClient | null = null;

function getMsiClient(): SupabaseClient {
  if (_msiClient) return _msiClient;

  const url = process.env.MSI_SUPABASE_URL;
  const key = process.env.MSI_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing MSI_SUPABASE_URL or MSI_SUPABASE_SERVICE_ROLE_KEY');
  }

  _msiClient = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _msiClient;
}

// ESPN competition_id → MSI league name
const COMPETITION_TO_MSI_LEAGUE: Record<string, string> = {
  'eng.1': 'Premier League',
  'ger.1': 'Bundesliga',
  'esp.1': 'La Liga',
  'fra.1': 'Ligue 1',
  'ita.1': 'Serie A',
  'uefa.champions': 'Champions League',
};

export function getMsiLeague(competitionId: string): string | null {
  return COMPETITION_TO_MSI_LEAGUE[competitionId] ?? null;
}

/**
 * Fetch MSI fixtures for a given date and league.
 * Deduplicates by (home_team, away_team, date) keeping highest fixture_id.
 */
export async function fetchMsiFixtures(
  dateStr: string,
  competitionId: string,
): Promise<MsiFixture[]> {
  const league = getMsiLeague(competitionId);
  if (!league) return [];

  try {
    const { data, error } = await getMsiClient()
      .from('matches')
      .select('fixture_id, home_team, away_team, league, commence_time, status, score')
      .eq('date', dateStr)
      .eq('league', league)
      .neq('status', 'cancelled')
      .order('fixture_id', { ascending: false });

    if (error) {
      console.error(`[MSI] Fetch fixtures failed for ${league} ${dateStr}:`, error.message);
      return [];
    }

    if (!data || data.length === 0) return [];

    // Deduplicate: keep highest fixture_id per (home_team, away_team)
    const seen = new Set<string>();
    const deduped: MsiFixture[] = [];
    for (const row of data) {
      const key = `${row.home_team}|${row.away_team}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }

    return deduped;
  } catch (err) {
    console.error(`[MSI] Fetch error:`, err);
    return [];
  }
}

/**
 * Fetch all MSI fixtures for a date range across all tracked leagues.
 */
export async function fetchAllMsiFixtures(dateStr: string): Promise<MsiFixture[]> {
  const leagues = Object.keys(COMPETITION_TO_MSI_LEAGUE);
  const results = await Promise.all(
    leagues.map((compId) => fetchMsiFixtures(dateStr, compId)),
  );
  return results.flat();
}
