import type {
  ESPNScoreboardResponse,
  ESPNEvent,
  ESPNDetail,
  ESPNCompetitor,
  NormalizedObservation,
  NormalizedEvent,
  MatchStatus,
  EventType,
} from '../types';

// ─── League Config ───────────────────────────────────────────────────────────

const SOCCER_LEAGUES = ['eng.1', 'ger.1', 'esp.1', 'fra.1', 'ita.1', 'uefa.champions'] as const;

const US_SPORTS = [
  { sport: 'basketball', league: 'nba', competitionId: 'nba' },
  { sport: 'baseball', league: 'mlb', competitionId: 'mlb' },
] as const;

// ─── Status Mapping ──────────────────────────────────────────────────────────

const ESPN_STATUS_MAP: Record<string, MatchStatus> = {
  STATUS_SCHEDULED: 'scheduled',
  STATUS_FIRST_HALF: 'live_first_half',
  STATUS_HALFTIME: 'halftime',
  STATUS_SECOND_HALF: 'live_second_half',
  STATUS_EXTRA_TIME: 'extra_time',
  STATUS_FULL_TIME: 'full_time',
  STATUS_IN_PROGRESS: 'in_progress',
  STATUS_FINAL: 'final',
  STATUS_POSTPONED: 'postponed',
  STATUS_CANCELED: 'cancelled',
  STATUS_CANCELLED: 'cancelled',
  STATUS_DELAYED: 'scheduled',
  STATUS_END_PERIOD: 'in_progress',
};

function mapESPNStatus(statusName: string, sport: string): MatchStatus {
  // For soccer, use the detailed status map
  if (sport === 'soccer') {
    return ESPN_STATUS_MAP[statusName] ?? 'unknown';
  }
  // For US sports, simplify to in_progress/final/scheduled
  return ESPN_STATUS_MAP[statusName] ?? 'unknown';
}

// ─── Event Mapping ───────────────────────────────────────────────────────────

function mapESPNDetail(detail: ESPNDetail, competitors: ESPNCompetitor[]): NormalizedEvent | null {
  const typeText = detail.type?.text?.toLowerCase() ?? '';
  let eventType: EventType | null = null;

  if (detail.ownGoal) {
    eventType = 'own_goal';
  } else if (detail.penaltyKick && detail.scoringPlay) {
    eventType = 'penalty_goal';
  } else if (detail.penaltyKick && !detail.scoringPlay) {
    eventType = 'penalty_miss';
  } else if (detail.scoringPlay) {
    eventType = 'goal';
  } else if (detail.redCard) {
    eventType = 'red_card';
  }

  if (!eventType) return null;

  // Determine team name from detail.team.id
  const teamName =
    competitors.find((c) => c.team.id === detail.team?.id)?.team.displayName ?? null;

  return {
    type: eventType,
    matchMinute: detail.clock?.displayValue ?? null,
    matchClockSeconds: detail.clock?.value != null ? Math.round(detail.clock.value) : null,
    teamName,
    playerName: detail.athletesInvolved?.[0]?.displayName ?? null,
    homeScoreAfter: null, // filled by consensus engine from running score
    awayScoreAfter: null,
  };
}

// ─── Fetch Helpers ───────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string): Promise<{ data: T; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    next: { revalidate: 0 },
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    throw new Error(`ESPN fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const data = (await res.json()) as T;
  return { data, latencyMs };
}

function parseESPNEvent(event: ESPNEvent, competitionId: string, sport: string, latencyMs: number): NormalizedObservation {
  const competition = event.competitions[0];
  const homeCompetitor = competition.competitors.find((c) => c.homeAway === 'home')!;
  const awayCompetitor = competition.competitors.find((c) => c.homeAway === 'away')!;

  const status = mapESPNStatus(event.status.type.name, sport);

  // Parse events from details (soccer only — NBA/MLB don't have useful details)
  const events: NormalizedEvent[] = [];
  if (sport === 'soccer' && competition.details) {
    for (const detail of competition.details) {
      const normalized = mapESPNDetail(detail, competition.competitors);
      if (normalized) events.push(normalized);
    }
  }

  return {
    source: 'espn',
    competitionId,
    espnEventId: event.id,
    fotmobMatchId: null,
    status,
    homeTeam: homeCompetitor.team.displayName,
    awayTeam: awayCompetitor.team.displayName,
    homeScore: parseInt(homeCompetitor.score, 10) || 0,
    awayScore: parseInt(awayCompetitor.score, 10) || 0,
    events,
    scheduledStart: new Date(event.date), // actual kickoff from ESPN
    observedAt: new Date(),
    latencyMs,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function fetchESPNSoccer(league: string, date?: string): Promise<NormalizedObservation[]> {
  const dateParam = date ? `?dates=${date}` : '';
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard${dateParam}`;
  const { data, latencyMs } = await fetchJSON<ESPNScoreboardResponse>(url);
  return (data.events ?? []).map((event) => parseESPNEvent(event, league, 'soccer', latencyMs));
}

export async function fetchESPNUS(
  sport: string,
  league: string,
  competitionId: string,
  date?: string,
): Promise<NormalizedObservation[]> {
  const dateParam = date ? `?dates=${date}` : '';
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard${dateParam}`;
  const { data, latencyMs } = await fetchJSON<ESPNScoreboardResponse>(url);
  return (data.events ?? []).map((event) => parseESPNEvent(event, competitionId, sport, latencyMs));
}

/**
 * Fetch all leagues in parallel. Returns flat array of observations.
 */
export async function fetchAllESPN(date?: string): Promise<NormalizedObservation[]> {
  const results = await Promise.allSettled([
    ...SOCCER_LEAGUES.map((league) => fetchESPNSoccer(league, date)),
    ...US_SPORTS.map(({ sport, league, competitionId }) =>
      fetchESPNUS(sport, league, competitionId, date),
    ),
  ]);

  const observations: NormalizedObservation[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      observations.push(...result.value);
    } else {
      console.error('[ESPN] Fetch failed:', result.reason);
    }
  }
  return observations;
}
