import { supabase } from './client';
import type { PollCycleLog, PollHealthStats } from '../types';

/**
 * Insert a single poll cycle iteration log.
 */
export async function insertPollCycleLog(log: Omit<PollCycleLog, 'id' | 'created_at'>): Promise<void> {
  const { error } = await supabase.from('poll_cycle_logs').insert({
    invocation_id: log.invocation_id,
    iteration: log.iteration,
    started_at: log.started_at,
    ended_at: log.ended_at,
    duration_ms: log.duration_ms,
    fixtures_polled: log.fixtures_polled,
    events_emitted: log.events_emitted,
    status_changes: log.status_changes,
    espn_latency_ms: log.espn_latency_ms,
    fotmob_latency_ms: log.fotmob_latency_ms,
    espn_observations: log.espn_observations,
    fotmob_observations: log.fotmob_observations,
    active_fixtures: log.active_fixtures,
    errors: JSON.stringify(log.errors),
  });

  if (error) {
    console.error('[DB] Insert poll cycle log failed:', error.message);
  }
}

/**
 * Get recent poll cycle logs for the status endpoint.
 */
export async function getRecentPollLogs(limit: number = 20): Promise<PollCycleLog[]> {
  const { data, error } = await supabase
    .from('poll_cycle_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[DB] Get recent poll logs failed:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Get aggregated poll health stats since a given time.
 */
export async function getPollHealthStats(sinceIso: string): Promise<PollHealthStats> {
  const { data, error } = await supabase
    .from('poll_cycle_logs')
    .select('duration_ms, espn_latency_ms, fotmob_latency_ms, events_emitted, errors')
    .gte('created_at', sinceIso);

  if (error || !data || data.length === 0) {
    return {
      cyclesLastHour: 0,
      avgCycleDurationMs: 0,
      avgEspnLatencyMs: 0,
      avgFotmobLatencyMs: 0,
      eventsDetectedLastHour: 0,
      errorCyclesLastHour: 0,
    };
  }

  const durations = data.map((r) => r.duration_ms);
  const espnLatencies = data.filter((r) => r.espn_latency_ms != null).map((r) => r.espn_latency_ms!);
  const fotmobLatencies = data.filter((r) => r.fotmob_latency_ms != null).map((r) => r.fotmob_latency_ms!);
  const totalEvents = data.reduce((s, r) => s + (r.events_emitted ?? 0), 0);
  const errorCycles = data.filter((r) => {
    const errors = r.errors;
    return Array.isArray(errors) ? errors.length > 0 : false;
  }).length;

  const avg = (arr: number[]) => (arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  return {
    cyclesLastHour: data.length,
    avgCycleDurationMs: avg(durations),
    avgEspnLatencyMs: avg(espnLatencies),
    avgFotmobLatencyMs: avg(fotmobLatencies),
    eventsDetectedLastHour: totalEvents,
    errorCyclesLastHour: errorCycles,
  };
}
