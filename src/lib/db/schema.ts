import type { Sport } from '../types';
import { getSupabase } from './client';

/**
 * Maps competition ID → sport for schema routing.
 */
const COMPETITION_SPORT_MAP: Record<string, Sport> = {
  'eng.1': 'soccer',
  'ger.1': 'soccer',
  'esp.1': 'soccer',
  'fra.1': 'soccer',
  'ita.1': 'soccer',
  'uefa.champions': 'soccer',
  nba: 'basketball',
  mlb: 'baseball',
};

const ALL_SPORTS: Sport[] = ['soccer', 'basketball', 'baseball'];

/**
 * Get the sport for a competition ID.
 */
export function getSportForCompetition(competitionId: string): Sport {
  return COMPETITION_SPORT_MAP[competitionId] ?? 'soccer';
}

/**
 * Get a supabase client scoped to a sport schema.
 * Usage: sportSchema('soccer').from('fixtures').select('*')
 */
export function sportSchema(sport: Sport) {
  return getSupabase().schema(sport);
}

/**
 * Query all sport schemas in parallel and merge results.
 * Useful for cross-sport queries (status endpoint, active windows, etc.)
 */
export async function queryAllSchemas<T>(
  queryFn: (schema: ReturnType<typeof sportSchema>) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const results = await Promise.all(
    ALL_SPORTS.map(async (sport) => {
      const { data, error } = await queryFn(sportSchema(sport));
      if (error) {
        console.error(`[DB] Query failed for ${sport} schema:`, error);
        return [];
      }
      return data ?? [];
    }),
  );
  return results.flat();
}

/**
 * Run an operation across all sport schemas in parallel.
 * Returns count of successful operations.
 */
export async function mutateAllSchemas(
  mutateFn: (schema: ReturnType<typeof sportSchema>) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<number> {
  const results = await Promise.all(
    ALL_SPORTS.map(async (sport) => {
      const { data, error } = await mutateFn(sportSchema(sport));
      if (error) {
        console.error(`[DB] Mutation failed for ${sport} schema:`, error);
        return 0;
      }
      return data?.length ?? 0;
    }),
  );
  return results.reduce((a, b) => a + b, 0);
}

export { ALL_SPORTS };
