import type {
  FotMobMatchesResponse,
  FotMobMatch,
  NormalizedObservation,
  MatchStatus,
} from '../types';

// Our tracked FotMob league IDs
const TRACKED_LEAGUE_IDS = new Set([47, 54, 87, 53, 55, 42]);

// League ID → competition ID mapping
const LEAGUE_ID_TO_COMPETITION: Record<number, string> = {
  47: 'eng.1',
  54: 'ger.1',
  87: 'esp.1',
  53: 'fra.1',
  55: 'ita.1',
  42: 'uefa.champions',
};

function mapFotMobStatus(match: FotMobMatch): MatchStatus {
  if (match.status.cancelled) return 'cancelled';
  if (match.status.finished) return 'full_time';
  if (match.status.started) return 'in_progress'; // FotMob doesn't differentiate halves
  return 'scheduled';
}

function parseFotMobMatch(match: FotMobMatch, competitionId: string, latencyMs: number): NormalizedObservation {
  return {
    source: 'fotmob',
    competitionId,
    espnEventId: null,
    fotmobMatchId: match.id,
    status: mapFotMobStatus(match),
    homeTeam: match.home.name,
    awayTeam: match.away.name,
    homeScore: match.home.score ?? 0,
    awayScore: match.away.score ?? 0,
    events: [], // FotMob matches list doesn't include event details
    scheduledStart: new Date(match.time), // kickoff time from FotMob
    observedAt: new Date(),
    latencyMs,
  };
}

/**
 * Fetch all FotMob matches for a given date. Single API call.
 * Only returns matches from our tracked leagues.
 */
export async function fetchFotMob(date?: string): Promise<NormalizedObservation[]> {
  const dateParam = date ? `?date=${date}` : '';
  const url = `https://www.fotmob.com/api/data/matches${dateParam}`;

  const start = Date.now();
  let data: FotMobMatchesResponse;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.fotmob.com/',
      },
      next: { revalidate: 0 },
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      console.error(`[FotMob] Fetch failed: ${res.status} ${res.statusText}`);
      return [];
    }

    data = (await res.json()) as FotMobMatchesResponse;

    const observations: NormalizedObservation[] = [];
    for (const league of data.leagues ?? []) {
      if (!TRACKED_LEAGUE_IDS.has(league.primaryId)) continue;
      const competitionId = LEAGUE_ID_TO_COMPETITION[league.primaryId];
      if (!competitionId) continue;

      for (const match of league.matches ?? []) {
        observations.push(parseFotMobMatch(match, competitionId, latencyMs));
      }
    }
    return observations;
  } catch (err) {
    console.error('[FotMob] Fetch error:', err);
    return [];
  }
}
