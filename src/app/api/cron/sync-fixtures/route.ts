import { NextResponse } from 'next/server';
import { coldSync } from '@/lib/scheduler/cold';

export const maxDuration = 300; // 5 min for cold sync
export const dynamic = 'force-dynamic';

/**
 * Vercel Cron: runs every 6 hours.
 * Syncs fixture schedule for next 14 days from ESPN + links FotMob IDs.
 */
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[Cron] Starting cold sync...');
    const result = await coldSync(14);

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Cold sync failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}
