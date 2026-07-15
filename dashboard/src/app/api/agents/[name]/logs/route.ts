import type { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getAgentPaths } from '@/lib/data/agents';
import { redactSSNForDisplay, stripLogControlSequences } from '@/lib/redact-ssn';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/agents/[name]/logs?type=activity&lines=500
// Returns the last N lines of a log file for the agent.
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  const { searchParams } = request.nextUrl;
  const logType = searchParams.get('type') ?? 'activity';
  const lines = Math.min(Number(searchParams.get('lines') ?? '500'), 5000);

  // Validate log type to prevent directory traversal
  if (!/^[\w.-]+$/.test(logType)) {
    return Response.json({ error: 'Invalid log type' }, { status: 400 });
  }

  const org = searchParams.get('org') || undefined;
  const paths = getAgentPaths(decoded, org);
  const logFile = path.join(paths.logsDir, `${logType}.log`);

  try {
    const content = await fs.readFile(logFile, 'utf-8');
    // Strip ANSI escapes + control chars FIRST (a mid-number escape would let a
    // bare-9 SSN evade the scrub below), then slice the tail.
    const cleaned = stripLogControlSequences(content);
    const allLines = cleaned.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    // Redact SSNs from the served content. The PTY Layer-1 holdback leaves two
    // documented residuals in stdout.log (R1: label-adjacent; R2: label >40
    // chars away, past the matcher lookback) and this log API is the one path
    // that surfaces stdout.log OFF-HOST, so it MUST close them — in AGGRESSIVE
    // mode so R2's distant label is irrelevant. Applied AFTER the strip on the
    // exact returned bytes. See redact-ssn.ts (canonical =
    // src/utils/ssn-redaction.ts, drift-guarded by an oracle test).
    const safe = redactSSNForDisplay(tail);
    return new Response(safe, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch {
    return new Response('', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
