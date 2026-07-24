import { describe, it, expect } from 'vitest';
import { checkTerminalInvariants } from '../../../../src/bus/triage/terminal-invariants';
import type { TriageWO } from '../../../../src/bus/triage/types';

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

describe('terminal invariants', () => {
  describe('MOLD_ESCALATE', () => {
    const moldTexts = [
      'There is mold on the wall',
      'I see mould in the bathroom',
      'Mildew on the shower tiles',
      'black spots on the ceiling',
      'dark spots on the wall near the window',
      'musty smell in the bedroom',
    ];

    for (const text of moldTexts) {
      it(`triggers on text: "${text}"`, () => {
        const wo = makeWO({ conversationText: text });
        const result = checkTerminalInvariants(wo);
        expect(result.terminal).toBe(true);
        expect(result.flag).toBe('MOLD_ESCALATE');
        expect(result.recipients).toEqual(['albie', 'rob']);
      });
    }

    it('triggers on vision analysis with mold', () => {
      const wo = makeWO({
        conversationText: 'There is something on the wall',
        visionAnalysis: 'Image shows possible mold growth on ceiling',
      });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('MOLD_ESCALATE');
      expect(result.recipients).toEqual(['albie', 'rob']);
    });

    it('triggers even with auto-send-eligible N/D tier', () => {
      const wo = makeWO({
        conversationText: 'There is mold on the wall',
        tier: 'N',
      });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('MOLD_ESCALATE');
    });
  });

  describe('LIFE_SAFETY_E0', () => {
    const e0Texts = [
      'There is a fire in the building',
      'I smell smoke coming from the wall',
      'Gas leak in the kitchen',
      'The carbon monoxide detector is going off',
      'CO alarm keeps beeping',
      'I got an electrical shock from the outlet',
      'There is arcing from the outlet',
      'A downed power line in the yard',
      'Someone was injured by the broken railing',
    ];

    for (const text of e0Texts) {
      it(`triggers on: "${text}"`, () => {
        const wo = makeWO({ conversationText: text });
        const result = checkTerminalInvariants(wo);
        expect(result.terminal).toBe(true);
        expect(result.flag).toBe('LIFE_SAFETY_E0');
        expect(result.recipients).toEqual(['albie']);
      });
    }
  });

  describe('SCOPE_EXCLUDED', () => {
    it('triggers for Belvedere property', () => {
      const wo = makeWO({ propertyAddress: '100 Belvedere Ave' });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('SCOPE_EXCLUDED');
      expect(result.recipients).toEqual(['albie']);
    });

    it('triggers for Tiburon property', () => {
      const wo = makeWO({ propertyAddress: '55 Tiburon Blvd' });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('SCOPE_EXCLUDED');
    });

    it('triggers for Paloma property', () => {
      const wo = makeWO({ propertyAddress: '219 Paloma Ave' });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('SCOPE_EXCLUDED');
    });
  });

  describe('precedence', () => {
    it('mold takes precedence over scope exclusion (mold ALWAYS escalates to both Albie+Rob)', () => {
      const wo = makeWO({
        propertyAddress: '100 Belvedere Ave',
        conversationText: 'There is mold on the wall',
      });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('MOLD_ESCALATE');
      expect(result.recipients).toEqual(['albie', 'rob']);
    });

    it('mold takes precedence over E0', () => {
      const wo = makeWO({
        conversationText: 'There is mold and also I smell gas leak',
      });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(true);
      expect(result.flag).toBe('MOLD_ESCALATE');
    });
  });

  describe('clean pass', () => {
    it('passes for normal maintenance request', () => {
      const wo = makeWO({ conversationText: 'The kitchen faucet is dripping constantly.' });
      const result = checkTerminalInvariants(wo);
      expect(result.terminal).toBe(false);
      expect(result.flag).toBeUndefined();
    });
  });
});
