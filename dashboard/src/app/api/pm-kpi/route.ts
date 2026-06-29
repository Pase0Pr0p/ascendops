// GET /api/pm-kpi — PM KPI snapshot.
//
// Returns live-updating KPI data from the AppFolio connector
// (mock by default; set APPFOLIO_CONNECTOR_PATH=stack-api + credentials for live).
//
// FIDUCIARY NOTE: all responses include is_demo:true when using mock connector.
// The dashboard MUST display a persistent SAMPLE/DEMO banner whenever is_demo is true.

import { createAppFolioConnector } from '@/lib/appfolio';
import { computePmKpis } from '@/lib/appfolio/kpi';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const connector = createAppFolioConnector();
    const kpis = await computePmKpis(connector);
    return Response.json(kpis);
  } catch (err) {
    console.error('[api/pm-kpi] error:', err);
    return Response.json({ error: 'Failed to compute KPIs' }, { status: 500 });
  }
}
