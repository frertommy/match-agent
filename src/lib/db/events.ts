import { sportSchema } from './schema';
import type { MatchEvent, SourceObservation, EventType, Sport } from '../types';

/**
 * Check for duplicate event (same fixture, type, within ±60s of clock).
 */
export async function findDuplicateEvent(
  sport: Sport,
  fixtureId: string,
  eventType: EventType,
  clockSeconds: number | null,
): Promise<MatchEvent | null> {
  if (clockSeconds == null) {
    const { data } = await sportSchema(sport)
      .from('match_events')
      .select('*')
      .eq('fixture_id', fixtureId)
      .eq('event_type', eventType)
      .limit(1);

    return data?.[0] ?? null;
  }

  const { data } = await sportSchema(sport)
    .from('match_events')
    .select('*')
    .eq('fixture_id', fixtureId)
    .eq('event_type', eventType)
    .gte('match_clock_seconds', clockSeconds - 60)
    .lte('match_clock_seconds', clockSeconds + 60)
    .limit(1);

  return data?.[0] ?? null;
}

/**
 * Insert a new match event or increment source_count on existing.
 */
export async function upsertMatchEvent(
  sport: Sport,
  event: {
    fixtureId: string;
    eventType: EventType;
    matchMinute: string | null;
    matchClockSeconds: number | null;
    teamName: string | null;
    playerName: string | null;
    homeScoreAfter: number | null;
    awayScoreAfter: number | null;
    confirmed: boolean;
    sourceCount: number;
    detectionLatencyMs?: number | null;
  },
): Promise<{ isNew: boolean }> {
  const existing = await findDuplicateEvent(sport, event.fixtureId, event.eventType, event.matchClockSeconds);

  if (existing) {
    const newSourceCount = Math.max(existing.source_count, event.sourceCount);
    const newConfirmed = newSourceCount >= 2 || event.confirmed;

    await sportSchema(sport)
      .from('match_events')
      .update({
        source_count: newSourceCount,
        confirmed: newConfirmed,
        home_score_after: event.homeScoreAfter ?? existing.home_score_after,
        away_score_after: event.awayScoreAfter ?? existing.away_score_after,
      })
      .eq('id', existing.id);

    return { isNew: false };
  }

  const { error } = await sportSchema(sport).from('match_events').insert({
    fixture_id: event.fixtureId,
    event_type: event.eventType,
    match_minute: event.matchMinute,
    match_clock_seconds: event.matchClockSeconds,
    team_name: event.teamName,
    player_name: event.playerName,
    home_score_after: event.homeScoreAfter,
    away_score_after: event.awayScoreAfter,
    confirmed: event.confirmed,
    source_count: event.sourceCount,
    first_reported_at: new Date().toISOString(),
    detection_latency_ms: event.detectionLatencyMs ?? null,
  });

  if (error) {
    console.error(`[DB] Insert event failed for ${event.fixtureId} in ${sport}:`, error.message);
    return { isNew: false };
  }

  return { isNew: true };
}

/**
 * Insert a raw source observation for audit trail.
 */
export async function insertObservation(sport: Sport, obs: Omit<SourceObservation, 'id'>): Promise<void> {
  const { error } = await sportSchema(sport).from('source_observations').insert(obs);

  if (error) {
    console.error(`[DB] Insert observation failed in ${sport}:`, error.message);
  }
}

/**
 * Get events for a fixture.
 */
export async function getEventsForFixture(sport: Sport, fixtureId: string): Promise<MatchEvent[]> {
  const { data, error } = await sportSchema(sport)
    .from('match_events')
    .select('*')
    .eq('fixture_id', fixtureId)
    .order('match_clock_seconds', { ascending: true });

  if (error) {
    console.error(`[DB] Get events failed for ${fixtureId} in ${sport}:`, error.message);
    return [];
  }
  return data ?? [];
}
