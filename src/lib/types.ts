// ─── Enums ───────────────────────────────────────────────────────────────────

export type MatchStatus =
  | 'scheduled'
  | 'live_first_half'
  | 'halftime'
  | 'live_second_half'
  | 'extra_time'
  | 'full_time'
  | 'in_progress'
  | 'final'
  | 'postponed'
  | 'cancelled'
  | 'unknown';

export type EventType =
  | 'goal'
  | 'red_card'
  | 'kickoff'
  | 'halftime'
  | 'full_time'
  | 'own_goal'
  | 'penalty_goal'
  | 'penalty_miss'
  | 'game_start'
  | 'game_end';

export type Sport = 'soccer' | 'basketball' | 'baseball';

// ─── DB Row Types ────────────────────────────────────────────────────────────

export interface Competition {
  id: string;
  name: string;
  sport: Sport;
  country: string;
  espn_slug: string;
  espn_sport: string;
  fotmob_league_id: number | null;
  team_count: number;
}

export interface Team {
  id: string;
  name: string;
  short_name: string | null;
  competition_id: string;
  espn_team_id: string | null;
  fotmob_team_id: number | null;
  created_at: string;
}

export interface Fixture {
  id: string;
  competition_id: string;
  home_team_id: string | null;
  away_team_id: string | null;
  home_team_name: string;
  away_team_name: string;
  scheduled_start: string;
  actual_kickoff: string | null;
  actual_end: string | null;
  home_score: number;
  away_score: number;
  status: MatchStatus;
  status_confirmed: boolean;
  espn_event_id: string | null;
  fotmob_match_id: number | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export interface MatchEvent {
  id?: number;
  fixture_id: string;
  event_type: EventType;
  match_minute: string | null;
  match_clock_seconds: number | null;
  team_name: string | null;
  player_name: string | null;
  home_score_after: number | null;
  away_score_after: number | null;
  confirmed: boolean;
  source_count: number;
  first_reported_at: string;
}

export interface SourceObservation {
  id?: number;
  fixture_id: string;
  source: 'espn' | 'fotmob';
  observed_status: string;
  observed_home_score: number | null;
  observed_away_score: number | null;
  observed_events: unknown;
  observed_at: string;
  latency_ms: number | null;
}

export interface PollWindow {
  id?: number;
  fixture_id: string;
  window_start: string;
  window_end: string;
  is_active: boolean;
}

// ─── Adapter Types ───────────────────────────────────────────────────────────

export interface NormalizedObservation {
  source: 'espn' | 'fotmob';
  competitionId: string;
  espnEventId: string | null;
  fotmobMatchId: number | null;
  status: MatchStatus;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  events: NormalizedEvent[];
  scheduledStart: Date; // actual kickoff time from source
  observedAt: Date;     // when we fetched this data
  latencyMs: number;
}

export interface NormalizedEvent {
  type: EventType;
  matchMinute: string | null;
  matchClockSeconds: number | null;
  teamName: string | null;
  playerName: string | null;
  homeScoreAfter: number | null;
  awayScoreAfter: number | null;
}

// ─── ESPN Raw Types ──────────────────────────────────────────────────────────

export interface ESPNScoreboardResponse {
  leagues: ESPNLeague[];
  events: ESPNEvent[];
}

export interface ESPNLeague {
  id: string;
  slug: string;
  name: string;
}

export interface ESPNEvent {
  id: string;
  date: string;
  name: string;
  status: {
    clock: number;
    displayClock: string;
    period: number;
    type: {
      id: string;
      name: string;
      state: string;
      completed: boolean;
      description: string;
    };
  };
  competitions: ESPNCompetition[];
}

export interface ESPNCompetition {
  id: string;
  competitors: ESPNCompetitor[];
  details?: ESPNDetail[];
}

export interface ESPNCompetitor {
  id: string;
  homeAway: 'home' | 'away';
  team: {
    id: string;
    displayName: string;
    shortDisplayName: string;
    abbreviation: string;
  };
  score: string;
}

export interface ESPNDetail {
  type: { text: string };
  clock: { displayValue: string; value: number };
  scoringPlay: boolean;
  redCard: boolean;
  yellowCard: boolean;
  ownGoal: boolean;
  penaltyKick: boolean;
  athletesInvolved?: { displayName: string }[];
  team: { id: string };
}

// ─── FotMob Raw Types ────────────────────────────────────────────────────────

export interface FotMobMatchesResponse {
  leagues: FotMobLeague[];
}

export interface FotMobLeague {
  primaryId: number;
  name: string;
  matches: FotMobMatch[];
}

export interface FotMobMatch {
  id: number;
  home: { name: string; score?: number; id: number };
  away: { name: string; score?: number; id: number };
  status: {
    started: boolean;
    finished: boolean;
    cancelled: boolean;
    scoreStr?: string;
    reason?: { short: string; long: string };
  };
  time: string;
  leagueId: number;
}

// ─── Poll Cycle Log ──────────────────────────────────────────────────────────

export interface PollCycleLog {
  id?: number;
  invocation_id: string;
  iteration: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  fixtures_polled: number;
  events_emitted: number;
  status_changes: number;
  espn_latency_ms: number | null;
  fotmob_latency_ms: number | null;
  espn_observations: number;
  fotmob_observations: number;
  active_fixtures: number;
  errors: string[];
  created_at?: string;
}

export interface HotPollCycleResult {
  fixturesPolled: number;
  eventsEmitted: number;
  statusChanges: number;
  espnLatencyMs: number | null;
  fotmobLatencyMs: number | null;
  espnObservations: number;
  fotmobObservations: number;
  activeFixtures: number;
  errors: string[];
}

export interface PollHealthStats {
  cyclesLastHour: number;
  avgCycleDurationMs: number;
  avgEspnLatencyMs: number;
  avgFotmobLatencyMs: number;
  eventsDetectedLastHour: number;
  errorCyclesLastHour: number;
}

// ─── Fixture Matching ────────────────────────────────────────────────────────

export interface FixtureLink {
  id?: number;
  espn_fixture_id: string;
  fotmob_match_id: number | null;
  api_football_fixture_id: number | null;
  competition_id: string;
  scheduled_start: string;
  match_method: 'exact' | 'alias' | 'ai';
  matched_at?: string;
}

export interface TeamNameMapping {
  id?: number;
  canonical_name: string;
  espn_name: string | null;
  fotmob_name: string | null;
  api_football_name: string | null;
  competition_id: string;
  match_method: string;
}

export interface MsiFixture {
  fixture_id: number;
  home_team: string;
  away_team: string;
  league: string;
  commence_time: string;
  status: string;
  score: string | null;
}

export type MatchSource = 'fotmob' | 'api_football';

export interface SourceCandidate {
  source: MatchSource;
  id: number;
  homeTeam: string;
  awayTeam: string;
  scheduledStart: string;
}

export interface AIMatchResult {
  espnFixtureId: string;
  candidateId: number;
  homeMapping: [string, string]; // [espn_name, candidate_name]
  awayMapping: [string, string];
}
