import { describe, it, expect } from 'vitest';
import { transition, createTriageWO } from '../../../../src/bus/triage/state-machine';
import type { TriageWO, TriageState } from '../../../../src/bus/triage/types';

function makeWO(overrides: Partial<TriageWO> = {}): TriageWO {
  return {
    woId: 'WO-1000',
    propertyAddress: '123 Main St',
    conversationText: 'The faucet is dripping.',
    photoUrls: [],
    escalationFlags: [],
    facts: [],
    state: 'INTAKE',
    ...overrides,
  };
}

describe('triage state machine', () => {
  describe('normal transitions', () => {
    it('transitions INTAKE -> READING', () => {
      const wo = makeWO();
      const result = transition(wo, 'READING');
      expect(result.success).toBe(true);
      expect(result.newState).toBe('READING');
      expect(wo.state).toBe('READING');
    });

    it('transitions through full pipeline', () => {
      const wo = makeWO();
      const steps: TriageState[] = ['READING', 'CLASSIFYING', 'DRAFTING', 'REVIEW', 'READY_FOR_HUMAN'];
      for (const step of steps) {
        const result = transition(wo, step);
        expect(result.success).toBe(true);
        expect(wo.state).toBe(step);
      }
    });

    it('rejects invalid transition', () => {
      const wo = makeWO();
      const result = transition(wo, 'REVIEW');
      expect(result.success).toBe(false);
      expect(wo.state).toBe('INTAKE');
    });
  });

  describe('terminal invariant enforcement', () => {
    it('mold in conversation forces ESCALATED at any pipeline stage', () => {
      const stages: TriageState[] = ['INTAKE', 'READING', 'CLASSIFYING', 'DRAFTING', 'REVIEW'];
      for (const stage of stages) {
        const wo = makeWO({ state: stage, conversationText: 'There is mold on the wall' });
        const target = stage === 'INTAKE' ? 'READING' : (stage === 'READING' ? 'CLASSIFYING' : 'DRAFTING');
        const result = transition(wo, target as TriageState);
        expect(wo.state).toBe('ESCALATED');
        expect(wo.terminalFlag).toBe('MOLD_ESCALATE');
        expect(wo.escalationFlags).toContain('MOLD_ESCALATE');
      }
    });

    it('E0 in conversation forces ESCALATED', () => {
      const wo = makeWO({ conversationText: 'I smell gas leak in the kitchen' });
      transition(wo, 'READING');
      expect(wo.state).toBe('ESCALATED');
      expect(wo.terminalFlag).toBe('LIFE_SAFETY_E0');
    });

    it('scope-excluded property forces ESCALATED', () => {
      const wo = makeWO({ propertyAddress: '100 Belvedere Ave' });
      transition(wo, 'READING');
      expect(wo.state).toBe('ESCALATED');
      expect(wo.terminalFlag).toBe('SCOPE_EXCLUDED');
    });

    it('ESCALATED is terminal — no outbound transitions', () => {
      const wo = makeWO({ state: 'ESCALATED' });
      const result = transition(wo, 'READING');
      expect(result.success).toBe(false);
      expect(wo.state).toBe('ESCALATED');
    });

    it('reclassification: mold appearing in later conversation update forces ESCALATED', () => {
      const wo = makeWO({ state: 'CLASSIFYING', conversationText: 'The faucet drips' });
      transition(wo, 'DRAFTING');
      expect(wo.state).toBe('DRAFTING');

      wo.conversationText += '\nUpdate: I also see mold on the wall near the leak';
      transition(wo, 'REVIEW');
      expect(wo.state).toBe('ESCALATED');
      expect(wo.terminalFlag).toBe('MOLD_ESCALATE');
    });

    it('reclassification: E0 appearing after classification forces ESCALATED', () => {
      const wo = makeWO({ state: 'REVIEW', conversationText: 'The faucet drips' });
      wo.conversationText += '\nUpdate: now I smell smoke coming from the wall';
      transition(wo, 'READY_FOR_HUMAN');
      expect(wo.state).toBe('ESCALATED');
      expect(wo.terminalFlag).toBe('LIFE_SAFETY_E0');
    });
  });

  describe('createTriageWO', () => {
    it('creates a WO in INTAKE state with empty collections', () => {
      const wo = createTriageWO('WO-5000', '456 Oak St', 'Toilet is running');
      expect(wo.woId).toBe('WO-5000');
      expect(wo.state).toBe('INTAKE');
      expect(wo.escalationFlags).toEqual([]);
      expect(wo.facts).toEqual([]);
    });
  });
});
