import type { Fixture, NormalizedObservation, MatchStatus, NormalizedEvent, Sport } from '../types';
import { updateFixtureStatus, findFixtureByTeams } from '../db/fixtures';
import { upsertMatchEvent, insertObservation } from '../db/events';
import { getSportForCompetition } from '../db/schema';

// ─── Status Lifecycle ────────────────────────────────────────────────────────

const LIVE_STATUSES: MatchStatus[] = [
  'live_first_half', 'halftime', 'live_second_half', 'extra_time', 'in_progress',
];

const TERMINAL_STATUSES: MatchStatus[] = ['full_time', 'final'];

const KICKOFF_STATUSES: MatchStatus[] = ['live_first_half', 'in_progress'];

function isLive(status: MatchStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

function isTerminal(status: MatchStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function isKickoff(status: MatchStatus): boolean {
  return KICKOFF_STATUSES.includes(status);
}

// ─── Consensus Result ────────────────────────────────────────────────────────

export interface ConsensusResult {
  fixtureId: string;
  competitionId: string;
  statusUpdate: MatchStatus | null;
  statusConfirmed: boolean;
  scoreUpdate: { home: number; away: number } | null;
  newEvents: Array<{
    type: NormalizedEvent['type'];
    matchMinute: string | null;
    matchClockSeconds: number | null;
    teamName: string | null;
    playerName: string | null;
    homeScoreAfter: number | null;
    awayScoreAfter: number | null;
  }>;
  lifecycleEvents: Array<'kickoff' | 'halftime' | 'full_time' | 'game_start' | 'game_end'>;
  /** When the source observation was fetched — used to compute detection latency */
  observedAt: Date | null;
}

// ─── Main Consensus Logic ────────────────────────────────────────────────────

/**
 * Run consensus for a single fixture using ESPN (primary) + optional FotMob observation.
 */
export function runConsensus(
  fixture: Fixture,
  espnObs: NormalizedObservation | null,
  fotmobObs: NormalizedObservation | null,
): ConsensusResult {
  const result: ConsensusResult = {
    fixtureId: fixture.id,
    competitionId: fixture.competition_id,
    statusUpdate: null,
    statusConfirmed: false,
    observedAt: espnObs?.observedAt ?? null,
    scoreUpdate: null,
    newEvents: [],
    lifecycleEvents: [],
  };

  if (!espnObs) return result;

  const isSoccer = !['nba', 'mlb'].includes(fixture.competition_id);
  const prevStatus = fixture.status;
  const newStatus = espnObs.status;

  // ─── Status Consensus ──────────────────────────────────────────────────

  // Detect status transitions
  if (newStatus !== prevStatus && newStatus !== 'unknown') {
    result.statusUpdate = newStatus;

    // Check if FotMob confirms (soccer only)
    if (isSoccer && fotmobObs) {
      const fotmobLive = isLive(fotmobObs.status) || isKickoff(fotmobObs.status);
      const espnLive = isLive(newStatus) || isKickoff(newStatus);
      const fotmobTerminal = isTerminal(fotmobObs.status);
      const espnTerminal = isTerminal(newStatus);

      if ((espnLive && fotmobLive) || (espnTerminal && fotmobTerminal)) {
        result.statusConfirmed = true;
      }
      // Score agreement adds confidence
      if (fotmobObs.homeScore === espnObs.homeScore && fotmobObs.awayScore === espnObs.awayScore) {
        result.statusConfirmed = true;
      }
    } else if (!isSoccer) {
      // NBA/MLB: ESPN is sole source, auto-confirmed
      result.statusConfirmed = true;
    }

    // ─── Lifecycle Events ──────────────────────────────────────────────

    // Match started
    if (prevStatus === 'scheduled' && isKickoff(newStatus)) {
      result.lifecycleEvents.push(isSoccer ? 'kickoff' : 'game_start');
    }

    // Halftime
    if (prevStatus !== 'halftime' && newStatus === 'halftime') {
      result.lifecycleEvents.push('halftime');
    }

    // Match ended
    if (!isTerminal(prevStatus) && isTerminal(newStatus)) {
      result.lifecycleEvents.push(isSoccer ? 'full_time' : 'game_end');
    }
  }

  // ─── Score Update ──────────────────────────────────────────────────────

  if (espnObs.homeScore !== fixture.home_score || espnObs.awayScore !== fixture.away_score) {
    result.scoreUpdate = { home: espnObs.homeScore, away: espnObs.awayScore };
  }

  // ─── Event Consensus (soccer only — goals, red cards) ──────────────────

  if (isSoccer && espnObs.events.length > 0) {
    for (const event of espnObs.events) {
      result.newEvents.push({
        type: event.type,
        matchMinute: event.matchMinute,
        matchClockSeconds: event.matchClockSeconds,
        teamName: event.teamName,
        playerName: event.playerName,
        homeScoreAfter: event.homeScoreAfter,
        awayScoreAfter: event.awayScoreAfter,
      });
    }
  }

  return result;
}

// ─── Apply Consensus to DB ───────────────────────────────────────────────────

/**
 * Apply a consensus result to the database.
 */
export async function applyConsensus(result: ConsensusResult): Promise<void> {
  const now = new Date().toISOString();
  const sport = getSportForCompetition(result.competitionId);

  // Update fixture status + scores
  if (result.statusUpdate || result.scoreUpdate) {
    const update: Record<string, unknown> = {};

    if (result.statusUpdate) {
      update.status = result.statusUpdate;
      update.status_confirmed = result.statusConfirmed;
    }

    if (result.scoreUpdate) {
      update.home_score = result.scoreUpdate.home;
      update.away_score = result.scoreUpdate.away;
    }

    // Set lifecycle timestamps
    if (result.lifecycleEvents.includes('kickoff') || result.lifecycleEvents.includes('game_start')) {
      update.actual_kickoff = now;
    }
    if (result.lifecycleEvents.includes('full_time') || result.lifecycleEvents.includes('game_end')) {
      update.actual_end = now;
    }

    await updateFixtureStatus(result.fixtureId, sport, update as Parameters<typeof updateFixtureStatus>[2]);
  }

  // Compute detection latency: time from observation fetch to now (DB write)
  const detectionLatencyMs = result.observedAt
    ? Date.now() - result.observedAt.getTime()
    : null;

  // Insert lifecycle events
  for (const le of result.lifecycleEvents) {
    await upsertMatchEvent(sport, {
      fixtureId: result.fixtureId,
      eventType: le,
      matchMinute: null,
      matchClockSeconds: null,
      teamName: null,
      playerName: null,
      homeScoreAfter: result.scoreUpdate?.home ?? null,
      awayScoreAfter: result.scoreUpdate?.away ?? null,
      confirmed: result.statusConfirmed,
      sourceCount: result.statusConfirmed ? 2 : 1,
      detectionLatencyMs,
    });
  }

  // Insert match events (goals, red cards)
  for (const event of result.newEvents) {
    await upsertMatchEvent(sport, {
      fixtureId: result.fixtureId,
      eventType: event.type,
      matchMinute: event.matchMinute,
      matchClockSeconds: event.matchClockSeconds,
      teamName: event.teamName,
      playerName: event.playerName,
      homeScoreAfter: event.homeScoreAfter,
      awayScoreAfter: event.awayScoreAfter,
      confirmed: true, // ESPN events are trusted
      sourceCount: 1,
      detectionLatencyMs,
    });
  }
}

// ─── Match FotMob to ESPN ────────────────────────────────────────────────────

/**
 * Try to find the FotMob observation that matches an ESPN fixture.
 * Match by fotmob_match_id first, then by team name fuzzy match.
 */
export function matchFotMobObs(
  fixture: Fixture,
  fotmobObservations: NormalizedObservation[],
): NormalizedObservation | null {
  // Direct ID match
  if (fixture.fotmob_match_id) {
    const match = fotmobObservations.find((o) => o.fotmobMatchId === fixture.fotmob_match_id);
    if (match) return match;
  }

  // Fuzzy team name match within same competition
  return (
    fotmobObservations.find((o) => {
      if (o.competitionId !== fixture.competition_id) return false;
      const homeMatch =
        o.homeTeam.toLowerCase().includes(fixture.home_team_name.toLowerCase().slice(0, 6)) ||
        fixture.home_team_name.toLowerCase().includes(o.homeTeam.toLowerCase().slice(0, 6));
      const awayMatch =
        o.awayTeam.toLowerCase().includes(fixture.away_team_name.toLowerCase().slice(0, 6)) ||
        fixture.away_team_name.toLowerCase().includes(o.awayTeam.toLowerCase().slice(0, 6));
      return homeMatch && awayMatch;
    }) ?? null
  );
}
