import { supabase } from './client';
import type { PollWindow, Competition } from '../types';

// Window durations per sport (in minutes)
const WINDOW_BUFFER_BEFORE = 5; // minutes before kickoff
const WINDOW_DURATION: Record<string, number> = {
  soccer: 130,     // 90 min + 45 min buffer for ET/delays
  basketball: 180, // NBA games ~2.5hrs with OT buffer
  baseball: 240,   // MLB games can go long
};

/**
 * Create or update a poll window for a fixture.
 */
export async function upsertPollWindow(
  fixtureId: string,
  scheduledStart: string,
  sport: string,
): Promise<void> {
  const startDate = new Date(scheduledStart);
  const windowStart = new Date(startDate.getTime() - WINDOW_BUFFER_BEFORE * 60_000);
  const durationMin = WINDOW_DURATION[sport] ?? 130;
  const windowEnd = new Date(startDate.getTime() + durationMin * 60_000);

  // Check if window already exists for this fixture
  const { data: existing } = await supabase
    .from('poll_windows')
    .select('id')
    .eq('fixture_id', fixtureId)
    .limit(1);

  if (existing && existing.length > 0) {
    // Update existing window
    await supabase
      .from('poll_windows')
      .update({
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
      })
      .eq('fixture_id', fixtureId);
  } else {
    // Insert new window
    const { error } = await supabase.from('poll_windows').insert({
      fixture_id: fixtureId,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      is_active: false,
    });

    if (error) {
      console.error(`[DB] Insert poll window failed for ${fixtureId}:`, error.message);
    }
  }
}

/**
 * Get all currently active poll windows (now is between window_start and window_end).
 */
export async function getActiveWindows(): Promise<PollWindow[]> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('poll_windows')
    .select('*')
    .lte('window_start', now)
    .gte('window_end', now);

  if (error) {
    console.error('[DB] Get active windows failed:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Activate windows that are now within their time range.
 */
export async function activateCurrentWindows(): Promise<number> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('poll_windows')
    .update({ is_active: true })
    .lte('window_start', now)
    .gte('window_end', now)
    .eq('is_active', false)
    .select('id');

  if (error) {
    console.error('[DB] Activate windows failed:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * Deactivate windows whose time has passed.
 */
export async function deactivateExpiredWindows(): Promise<number> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('poll_windows')
    .update({ is_active: false })
    .lt('window_end', now)
    .eq('is_active', true)
    .select('id');

  if (error) {
    console.error('[DB] Deactivate windows failed:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

/**
 * Get fixture IDs for all currently active windows.
 */
export async function getActiveFixtureIds(): Promise<string[]> {
  const windows = await getActiveWindows();
  return windows.map((w) => w.fixture_id);
}
