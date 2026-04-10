import { supabase } from './client';
import type { Fixture, MatchStatus, NormalizedObservation } from '../types';

/**
 * Upsert a fixture from an ESPN observation (cold sync).
 * Creates new fixture or updates schedule/IDs if already exists.
 */
export async function upsertFixtureFromESPN(obs: NormalizedObservation, scheduledStart: string): Promise<void> {
  const fixtureId = `espn_${obs.espnEventId}`;

  const { error } = await supabase
    .from('fixtures')
    .upsert(
      {
        id: fixtureId,
        competition_id: obs.competitionId,
        home_team_name: obs.homeTeam,
        away_team_name: obs.awayTeam,
        scheduled_start: scheduledStart,
        home_score: obs.homeScore,
        away_score: obs.awayScore,
        status: obs.status,
        espn_event_id: obs.espnEventId,
      },
      { onConflict: 'id' },
    );

  if (error) {
    console.error(`[DB] Upsert fixture ${fixtureId} failed:`, error.message);
  }
}

/**
 * Link a FotMob match ID to an existing fixture (matched by team names + competition + date).
 */
export async function linkFotMobId(fixtureId: string, fotmobMatchId: number): Promise<void> {
  const { error } = await supabase
    .from('fixtures')
    .update({ fotmob_match_id: fotmobMatchId })
    .eq('id', fixtureId);

  if (error) {
    console.error(`[DB] Link FotMob ID failed for ${fixtureId}:`, error.message);
  }
}

/**
 * Get all fixtures within a date range.
 */
export async function getFixturesByDateRange(start: string, end: string): Promise<Fixture[]> {
  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .gte('scheduled_start', start)
    .lte('scheduled_start', end)
    .order('scheduled_start');

  if (error) {
    console.error('[DB] Get fixtures by date range failed:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Get all live/active fixtures.
 */
export async function getLiveFixtures(): Promise<Fixture[]> {
  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .in('status', ['live_first_half', 'halftime', 'live_second_half', 'extra_time', 'in_progress']);

  if (error) {
    console.error('[DB] Get live fixtures failed:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Get fixtures by ESPN event IDs (for matching during hot poll).
 */
export async function getFixturesByESPNIds(espnIds: string[]): Promise<Fixture[]> {
  if (espnIds.length === 0) return [];
  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .in('espn_event_id', espnIds);

  if (error) {
    console.error('[DB] Get fixtures by ESPN IDs failed:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Update fixture status and scores during hot polling.
 */
export async function updateFixtureStatus(
  fixtureId: string,
  update: {
    status?: MatchStatus;
    status_confirmed?: boolean;
    home_score?: number;
    away_score?: number;
    actual_kickoff?: string;
    actual_end?: string;
  },
): Promise<void> {
  const { error } = await supabase.from('fixtures').update(update).eq('id', fixtureId);

  if (error) {
    console.error(`[DB] Update fixture ${fixtureId} failed:`, error.message);
  }
}

/**
 * Find a fixture by team names + competition + date for FotMob matching.
 */
export async function findFixtureByTeams(
  competitionId: string,
  homeTeam: string,
  awayTeam: string,
  dateStr: string,
): Promise<Fixture | null> {
  const dayStart = `${dateStr}T00:00:00Z`;
  const dayEnd = `${dateStr}T23:59:59Z`;

  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .eq('competition_id', competitionId)
    .gte('scheduled_start', dayStart)
    .lte('scheduled_start', dayEnd);

  if (error || !data) return null;

  // Fuzzy match on team names (FotMob may use slightly different names)
  return (
    data.find((f) => {
      const homeMatch =
        f.home_team_name.toLowerCase().includes(homeTeam.toLowerCase().slice(0, 6)) ||
        homeTeam.toLowerCase().includes(f.home_team_name.toLowerCase().slice(0, 6));
      const awayMatch =
        f.away_team_name.toLowerCase().includes(awayTeam.toLowerCase().slice(0, 6)) ||
        awayTeam.toLowerCase().includes(f.away_team_name.toLowerCase().slice(0, 6));
      return homeMatch && awayMatch;
    }) ?? null
  );
}
