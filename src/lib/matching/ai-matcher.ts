import Anthropic from '@anthropic-ai/sdk';
import type { AIMatchResult, SourceCandidate, MatchSource } from '../types';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

interface UnmatchedGroup {
  competitionId: string;
  date: string;
  espnFixtures: Array<{ id: string; homeTeam: string; awayTeam: string }>;
  candidates: Array<{ source: MatchSource; id: number; homeTeam: string; awayTeam: string }>;
}

/**
 * Batch AI matching: send all unmatched fixtures to Haiku in a single call.
 * Groups are organized by (competition, date) for context.
 * Returns match results + team name pairs for caching.
 */
export async function batchAIMatch(groups: UnmatchedGroup[]): Promise<AIMatchResult[]> {
  if (groups.length === 0) return [];

  // Filter out groups with no candidates or no ESPN fixtures
  const validGroups = groups.filter(
    (g) => g.espnFixtures.length > 0 && g.candidates.length > 0,
  );
  if (validGroups.length === 0) return [];

  // Build the prompt
  const sections: string[] = [];
  for (const group of validGroups) {
    const sourceName = group.candidates[0]?.source === 'fotmob' ? 'FotMob' : 'API-Football';

    let section = `## ${group.competitionId} — ${group.date}\n\nESPN:\n`;
    for (const f of group.espnFixtures) {
      section += `  ${f.id}: ${f.homeTeam} vs ${f.awayTeam}\n`;
    }
    section += `\n${sourceName}:\n`;
    for (const c of group.candidates) {
      section += `  ${c.id}: ${c.homeTeam} vs ${c.awayTeam}\n`;
    }
    sections.push(section);
  }

  const prompt = `Match ESPN fixtures to their counterparts from the other source. Same league, same date — match by team identity (not string similarity). Teams may have different naming conventions (e.g. "Wolverhampton Wanderers" = "Wolves", "1. FC Köln" = "FC Cologne", "Internazionale" = "Inter").

${sections.join('\n')}

Return ONLY a JSON array. Each element: {"espn_id": "...", "candidate_id": ..., "home": ["ESPN name", "candidate name"], "away": ["ESPN name", "candidate name"]}
Only include confident matches. If unsure, omit that fixture.`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-20250414',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from response
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => {
        if (block.type === 'text') return block.text;
        return '';
      })
      .join('');

    // Parse JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[AI Matcher] No JSON array found in response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      espn_id: string;
      candidate_id: number;
      home: [string, string];
      away: [string, string];
    }>;

    // Convert to AIMatchResult
    return parsed.map((r) => ({
      espnFixtureId: r.espn_id,
      candidateId: r.candidate_id,
      homeMapping: r.home,
      awayMapping: r.away,
    }));
  } catch (err) {
    console.error('[AI Matcher] Failed:', err);
    return [];
  }
}
