import { NextResponse } from 'next/server';
import { hotPollCycle } from '@/lib/scheduler/hot';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * Hot poll endpoint: triggered by check-windows cron or manually.
 * Runs a single poll cycle across all active fixtures.
 */
export async function POST(request: Request) {
  // Verify secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await hotPollCycle();

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Hot Poll] Cycle failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}
