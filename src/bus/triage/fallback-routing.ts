import type { FallbackHandoff } from './types.js';

export interface FallbackCheckResult {
  robReceives: boolean;
  reason: string;
}

export function checkFallbackRouting(handoff: FallbackHandoff | null | undefined, now?: Date): FallbackCheckResult {
  if (!handoff || !handoff.active) {
    return { robReceives: false, reason: 'No active fallback handoff — Rob does not receive routine WOs' };
  }

  const currentTime = now ?? new Date();
  const effectiveFrom = new Date(handoff.effective_from);
  const expiresAt = new Date(handoff.expires_at);

  if (isNaN(effectiveFrom.getTime()) || isNaN(expiresAt.getTime())) {
    return { robReceives: false, reason: 'Fallback handoff has invalid dates — fail-closed, Rob does not receive' };
  }

  if (currentTime < effectiveFrom) {
    return { robReceives: false, reason: 'Fallback handoff not yet effective' };
  }

  if (currentTime > expiresAt) {
    return { robReceives: false, reason: 'Fallback handoff expired — Rob does not receive' };
  }

  return { robReceives: true, reason: `Active fallback handoff set by ${handoff.set_by}: ${handoff.reason}` };
}
