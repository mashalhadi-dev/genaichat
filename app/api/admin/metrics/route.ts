import { getMonitoringSnapshot } from '@/lib/monitoring';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(getMonitoringSnapshot(), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
