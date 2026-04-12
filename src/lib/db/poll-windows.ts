import { sportSchema, getSportForCompetition, queryAllSchemas, mutateAllSchemas } from './schema';
import type { PollWindow, Sport } from '../types';

// Window durations per sport (in minutes)
const WINDOW_BUFFER_BEFORE = 5;
const WINDOW_DURATION: Record<string, number> = {
  soccer: 130,
  basketball: 180,
  baseball: 240,
};

/**
 * Create or update a poll window for a fixture.
 */
export async function upsertPollWindow(
  fixtureId: string,
  scheduledStart: string,
  sport: Sport,
): Promise<void> {
  const startDate = new Date(scheduledStart);
  const windowStart = new Date(startDate.getTime() - WINDOW_BUFFER_BEFORE * 60_000);
  const durationMin = WINDOW_DURATION[sport] ?? 130;
  const windowEnd = new Date(startDate.getTime() + durationMin * 60_000);

  const { data: existing } = await sportSchema(sport)
    .from('poll_windows')
    .select('id')
    .eq('fixture_id', fixtureId)
    .limit(1);

  if (existing && existing.length > 0) {
    await sportSchema(sport)
      .from('poll_windows')
      .update({
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
      })
      .eq('fixture_id', fixtureId);
  } else {
    const { error } = await sportSchema(sport).from('poll_windows').insert({
      fixture_id: fixtureId,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      is_active: false,
    });

    if (error) {
      console.error(`[DB] Insert poll window failed for ${fixtureId} in ${sport}:`, error.message);
    }
  }
}

/**
 * Get all currently active poll windows across all sports.
 */
export async function getActiveWindows(): Promise<PollWindow[]> {
  const now = new Date().toISOString();
  return queryAllSchemas((schema) =>
    schema
      .from('poll_windows')
      .select('*')
      .lte('window_start', now)
      .gte('window_end', now),
  );
}

/**
 * Activate windows across all sports that are now within their time range.
 */
export async function activateCurrentWindows(): Promise<number> {
  const now = new Date().toISOString();
  return mutateAllSchemas((schema) =>
    schema
      .from('poll_windows')
      .update({ is_active: true })
      .lte('window_start', now)
      .gte('window_end', now)
      .eq('is_active', false)
      .select('id'),
  );
}

/**
 * Deactivate expired windows across all sports.
 */
export async function deactivateExpiredWindows(): Promise<number> {
  const now = new Date().toISOString();
  return mutateAllSchemas((schema) =>
    schema
      .from('poll_windows')
      .update({ is_active: false })
      .lt('window_end', now)
      .eq('is_active', true)
      .select('id'),
  );
}

/**
 * Get fixture IDs for all currently active windows across all sports.
 */
export async function getActiveFixtureIds(): Promise<string[]> {
  const windows = await getActiveWindows();
  return windows.map((w) => w.fixture_id);
}
