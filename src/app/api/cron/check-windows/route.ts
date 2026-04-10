import { NextResponse } from 'next/server';
import { getActiveWindows, activateCurrentWindows, deactivateExpiredWindows } from '@/lib/db/poll-windows';

export const dynamic = 'force-dynamic';

/**
 * Vercel Cron: runs every 1 minute.
 * Checks if any poll windows are currently active.
 * If so, triggers a hot poll cycle.
 */
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Activate/deactivate windows
    const activated = await activateCurrentWindows();
    const deactivated = await deactivateExpiredWindows();
    const activeWindows = await getActiveWindows();

    if (activeWindows.length === 0) {
      return NextResponse.json({
        success: true,
        active: false,
        message: 'No active windows',
        activated,
        deactivated,
        timestamp: new Date().toISOString(),
      });
    }

    // Trigger hot poll by calling the hot poll endpoint
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const pollResponse = await fetch(`${baseUrl}/api/poll/hot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
    });

    const pollResult = await pollResponse.json();

    return NextResponse.json({
      success: true,
      active: true,
      activeWindows: activeWindows.length,
      activated,
      deactivated,
      pollResult,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Check windows failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
  }
}
