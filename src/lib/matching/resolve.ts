import { getSupabase } from '../db/client';
import { batchAIMatch } from './ai-matcher';
import type {
  Fixture,
  FixtureLink,
  TeamNameMapping,
  SourceCandidate,
  MatchSource,
  AIMatchResult,
} from '../types';

// ─── Name Normalization ──────────────────────────────────────────────────────

const STRIP_PREFIXES = /^(fc|sc|ac|as|cf|afc|sv|vfb|vfl|rb|tsv|fsv|1\.\s*fc)\s+/i;
const STRIP_SUFFIXES = /\s+(fc|sc|sv|cf|united|utd|city|town|athletic|wanderers|rovers|hotspur|albion|argyle)$/i;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(STRIP_PREFIXES, '')
    .replace(STRIP_SUFFIXES, '')
    .replace(/[^a-z0-9\s]/g, '') // strip non-alphanumeric
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Step 1: Exact Normalized Match ──────────────────────────────────────────

function tryExactMatch(
  espnHome: string,
  espnAway: string,
  candidates: SourceCandidate[],
): SourceCandidate | null {
  const nh = normalize(espnHome);
  const na = normalize(espnAway);

  return (
    candidates.find((c) => {
      return normalize(c.homeTeam) === nh && normalize(c.awayTeam) === na;
    }) ?? null
  );
}

// ─── Step 2: Alias Table Lookup ──────────────────────────────────────────────

function tryAliasMatch(
  espnHome: string,
  espnAway: string,
  candidates: SourceCandidate[],
  aliasMap: Map<string, string>, // espn_name → candidate source name
): SourceCandidate | null {
  const resolvedHome = aliasMap.get(espnHome.toLowerCase());
  const resolvedAway = aliasMap.get(espnAway.toLowerCase());

  if (!resolvedHome || !resolvedAway) return null;

  return (
    candidates.find((c) => {
      return (
        c.homeTeam.toLowerCase() === resolvedHome.toLowerCase() &&
        c.awayTeam.toLowerCase() === resolvedAway.toLowerCase()
      );
    }) ?? null
  );
}

// ─── Load Team Name Map ──────────────────────────────────────────────────────

/**
 * Load team name mappings from DB into memory.
 * Returns a Map keyed by lowercase espn_name → target source name.
 */
export async function loadTeamNameMap(
  source: MatchSource = 'fotmob',
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  const { data, error } = await getSupabase()
    .from('team_name_map')
    .select('espn_name, fotmob_name, api_football_name')
    .not('espn_name', 'is', null);

  if (error) {
    console.error(`[Resolve] Load team name map failed:`, error.message);
    return map;
  }

  for (const row of data ?? []) {
    const targetName = source === 'fotmob' ? row.fotmob_name : row.api_football_name;
    if (row.espn_name && targetName) {
      map.set(row.espn_name.toLowerCase(), targetName);
    }
  }

  return map;
}

/**
 * Load fotmob team name map for hot polling.
 * Returns Map<lowercase_espn_name, fotmob_name>
 */
export async function loadFotMobAliasMap(): Promise<Map<string, string>> {
  return loadTeamNameMap('fotmob');
}

// ─── Write Helpers ───────────────────────────────────────────────────────────

async function upsertFixtureLink(link: Omit<FixtureLink, 'id' | 'matched_at'>): Promise<void> {
  const { error } = await getSupabase()
    .from('fixture_links')
    .upsert(
      {
        espn_fixture_id: link.espn_fixture_id,
        fotmob_match_id: link.fotmob_match_id,
        api_football_fixture_id: link.api_football_fixture_id,
        competition_id: link.competition_id,
        scheduled_start: link.scheduled_start,
        match_method: link.match_method,
        matched_at: new Date().toISOString(),
      },
      { onConflict: 'espn_fixture_id' },
    );

  if (error) {
    console.error(`[Resolve] Upsert fixture link failed for ${link.espn_fixture_id}:`, error.message);
  }
}

async function upsertTeamNameMapping(
  espnName: string,
  candidateName: string,
  source: MatchSource,
  competitionId: string,
  method: string,
): Promise<void> {
  const targetCol = source === 'fotmob' ? 'fotmob_name' : 'api_football_name';

  // Check if ESPN name already exists for this competition
  const { data: existing } = await getSupabase()
    .from('team_name_map')
    .select('id, espn_name')
    .eq('espn_name', espnName)
    .eq('competition_id', competitionId)
    .limit(1);

  if (existing && existing.length > 0) {
    // Update existing row with new source name
    await getSupabase()
      .from('team_name_map')
      .update({ [targetCol]: candidateName, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id);
  } else {
    // Insert new row
    const { error } = await getSupabase().from('team_name_map').insert({
      canonical_name: espnName,
      espn_name: espnName,
      [targetCol]: candidateName,
      competition_id: competitionId,
      match_method: method,
    });

    if (error) {
      // Likely unique constraint — another source already has this name
      console.warn(`[Resolve] Insert team name mapping skipped (${espnName} → ${candidateName}):`, error.message);
    }
  }
}

// ─── Main Resolve Pipeline ───────────────────────────────────────────────────

export interface ResolveStats {
  exact: number;
  alias: number;
  ai: number;
  unmatched: number;
}

/**
 * Resolve fixture links between ESPN fixtures and candidates from another source.
 * Runs the 3-step cascade: exact → alias → AI.
 * Writes results to fixture_links and team_name_map tables.
 */
export async function resolveFixtureLinks(
  espnFixtures: Array<{ id: string; competitionId: string; homeTeam: string; awayTeam: string; scheduledStart: string }>,
  source: MatchSource,
  candidates: SourceCandidate[],
  options: { useAI?: boolean } = { useAI: true },
): Promise<ResolveStats> {
  const stats: ResolveStats = { exact: 0, alias: 0, ai: 0, unmatched: 0 };
  if (espnFixtures.length === 0 || candidates.length === 0) return stats;

  // Load alias map for this source
  const aliasMap = await loadTeamNameMap(source);

  // Track which candidates have been matched (prevent double-matching)
  const matchedCandidateIds = new Set<number>();
  const unmatchedEspn: typeof espnFixtures = [];

  for (const espn of espnFixtures) {
    // Filter candidates to same competition
    const compCandidates = candidates.filter(
      (c) => !matchedCandidateIds.has(c.id),
    );

    // Step 1: Exact normalized match
    let match = tryExactMatch(espn.homeTeam, espn.awayTeam, compCandidates);
    let method: 'exact' | 'alias' | 'ai' = 'exact';

    // Step 2: Alias lookup
    if (!match) {
      match = tryAliasMatch(espn.homeTeam, espn.awayTeam, compCandidates, aliasMap);
      method = 'alias';
    }

    if (match) {
      matchedCandidateIds.add(match.id);

      const linkData: Omit<FixtureLink, 'id' | 'matched_at'> = {
        espn_fixture_id: espn.id,
        fotmob_match_id: source === 'fotmob' ? match.id : null,
        api_football_fixture_id: source === 'api_football' ? match.id : null,
        competition_id: espn.competitionId,
        scheduled_start: espn.scheduledStart,
        match_method: method,
      };

      await upsertFixtureLink(linkData);
      stats[method]++;

      // If exact match, also cache the name mapping (in case names differ slightly)
      if (method === 'exact' && espn.homeTeam !== match.homeTeam) {
        await upsertTeamNameMapping(espn.homeTeam, match.homeTeam, source, espn.competitionId, 'exact');
      }
      if (method === 'exact' && espn.awayTeam !== match.awayTeam) {
        await upsertTeamNameMapping(espn.awayTeam, match.awayTeam, source, espn.competitionId, 'exact');
      }
    } else {
      unmatchedEspn.push(espn);
    }
  }

  // Step 3: AI batch matching for remaining unmatched
  if (options.useAI && unmatchedEspn.length > 0 && process.env.ANTHROPIC_API_KEY) {
    const remainingCandidates = candidates.filter((c) => !matchedCandidateIds.has(c.id));

    if (remainingCandidates.length > 0) {
      // Group by competition for the AI prompt
      const groupMap = new Map<string, { espn: typeof unmatchedEspn; cands: SourceCandidate[] }>();
      for (const espn of unmatchedEspn) {
        if (!groupMap.has(espn.competitionId)) {
          groupMap.set(espn.competitionId, { espn: [], cands: [] });
        }
        groupMap.get(espn.competitionId)!.espn.push(espn);
      }
      for (const cand of remainingCandidates) {
        // Find which competition group this candidate belongs to (by checking ESPN fixtures in same group)
        for (const [compId, group] of groupMap) {
          if (group.espn.length > 0) {
            group.cands.push(cand);
            break; // candidates don't have competitionId, add to first group
          }
        }
      }

      const aiGroups = Array.from(groupMap.entries()).map(([compId, group]) => ({
        competitionId: compId,
        date: unmatchedEspn[0]?.scheduledStart?.slice(0, 10) ?? '',
        espnFixtures: group.espn.map((e) => ({ id: e.id, homeTeam: e.homeTeam, awayTeam: e.awayTeam })),
        candidates: group.cands.map((c) => ({ ...c })),
      }));

      console.log(`[Resolve] AI matching ${unmatchedEspn.length} unmatched fixtures...`);
      const aiResults = await batchAIMatch(aiGroups);

      for (const result of aiResults) {
        const espn = unmatchedEspn.find((e) => e.id === result.espnFixtureId);
        if (!espn) continue;

        await upsertFixtureLink({
          espn_fixture_id: result.espnFixtureId,
          fotmob_match_id: source === 'fotmob' ? result.candidateId : null,
          api_football_fixture_id: source === 'api_football' ? result.candidateId : null,
          competition_id: espn.competitionId,
          scheduled_start: espn.scheduledStart,
          match_method: 'ai',
        });

        // Cache the team name mappings (self-training)
        await upsertTeamNameMapping(
          result.homeMapping[0], result.homeMapping[1],
          source, espn.competitionId, 'ai',
        );
        await upsertTeamNameMapping(
          result.awayMapping[0], result.awayMapping[1],
          source, espn.competitionId, 'ai',
        );

        stats.ai++;
      }

      // Count remaining unmatched
      stats.unmatched = unmatchedEspn.length - stats.ai;
    } else {
      stats.unmatched = unmatchedEspn.length;
    }
  } else {
    stats.unmatched = unmatchedEspn.length;
  }

  console.log(
    `[Resolve] ${source}: ${stats.exact} exact, ${stats.alias} alias, ${stats.ai} AI, ${stats.unmatched} unmatched`,
  );

  return stats;
}

/**
 * Look up an existing fixture link by ESPN fixture ID.
 * Used in hot polling — DB lookup only, no AI.
 */
export async function lookupFixtureLink(espnFixtureId: string): Promise<FixtureLink | null> {
  const { data, error } = await getSupabase()
    .from('fixture_links')
    .select('*')
    .eq('espn_fixture_id', espnFixtureId)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}
