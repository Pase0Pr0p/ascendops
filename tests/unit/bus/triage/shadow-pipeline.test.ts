import { describe, it, expect } from 'vitest';
import { runShadowPipeline } from '../../../../src/bus/triage/shadow-pipeline';
import type { PipelineInput } from '../../../../src/bus/triage/shadow-pipeline';

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    woId: 'WO-5000',
    propertyAddress: '321 Pine St',
    conversationText: 'The kitchen faucet is dripping slowly.',
    phase: 1,
    actionType: 'SEND_TENANT',
    purpose: 'ACK',
    messageBytes: 'We received your maintenance request and will look into it shortly.',
    ...overrides,
  };
}

describe('shadow-pipeline', () => {
  describe('normal flow', () => {
    it('runs full pipeline for a normal WO', () => {
      const input = makeInput({ phase: 1 });
      const result = runShadowPipeline(input);

      expect(result.wo.woId).toBe('WO-5000');
      expect(result.classification).not.toBeNull();
      expect(result.classification!.tier).toBe('N');
      expect(result.gateOutput).not.toBeNull();
      expect(result.escalated).toBe(false);
      expect(result.finalState).toBe('READY_FOR_HUMAN');
    });

    it('classifies tier correctly through pipeline', () => {
      const input = makeInput({
        conversationText: 'The apartment is flooding from the ceiling',
        phase: 1,
      });
      const result = runShadowPipeline(input);

      expect(result.classification).not.toBeNull();
      expect(result.classification!.tier).toBe('E1');
    });

    it('detects escalation flags through pipeline', () => {
      const input = makeInput({
        conversationText: 'The elderly tenant says the drain is clogged again for the third time',
        phase: 1,
      });
      const result = runShadowPipeline(input);

      expect(result.classification).not.toBeNull();
      expect(result.classification!.escalationFlags).toContain('VULNERABLE_OCCUPANT');
      expect(result.classification!.escalationFlags).toContain('REPEAT_FAILURE');
    });

    it('populates WO with tenant metadata', () => {
      const input = makeInput({
        tenantName: 'Maria Garcia',
        tenantContact: 'maria@email.com',
        unitId: 'Unit 3A',
      });
      const result = runShadowPipeline(input);

      expect(result.wo.tenantName).toBe('Maria Garcia');
      expect(result.wo.tenantContact).toBe('maria@email.com');
      expect(result.wo.unitId).toBe('Unit 3A');
    });

    it('populates WO with photo/vision data', () => {
      const input = makeInput({
        photoUrls: ['https://example.com/photo1.jpg'],
        visionAnalysis: 'Photo shows water staining on ceiling tiles',
      });
      const result = runShadowPipeline(input);

      expect(result.wo.photoUrls).toHaveLength(1);
      expect(result.wo.visionAnalysis).toBe('Photo shows water staining on ceiling tiles');
    });
  });

  describe('terminal invariant escalation', () => {
    it('escalates mold WO before classification', () => {
      const input = makeInput({
        conversationText: 'There is black mold growing behind the shower',
      });
      const result = runShadowPipeline(input);

      expect(result.escalated).toBe(true);
      expect(result.escalationReason).toContain('Mold');
      expect(result.wo.state).toBe('ESCALATED');
      expect(result.classification).toBeNull();
    });

    it('escalates E0 life safety WO before classification', () => {
      const input = makeInput({
        conversationText: 'There is a fire in the kitchen and smoke everywhere',
      });
      const result = runShadowPipeline(input);

      expect(result.escalated).toBe(true);
      expect(result.wo.state).toBe('ESCALATED');
      expect(result.classification).toBeNull();
    });

    it('escalates scope-excluded property', () => {
      const input = makeInput({
        propertyAddress: '55 Belvedere Ave',
      });
      const result = runShadowPipeline(input);

      expect(result.escalated).toBe(true);
      expect(result.wo.state).toBe('ESCALATED');
      expect(result.escalationReason).toContain('scope exclusion');
    });

    it('escalates Tiburon property', () => {
      const input = makeInput({
        propertyAddress: '10 Tiburon Blvd',
      });
      const result = runShadowPipeline(input);

      expect(result.escalated).toBe(true);
    });

    it('escalates Paloma property', () => {
      const input = makeInput({
        propertyAddress: '219 Paloma Ave',
      });
      const result = runShadowPipeline(input);

      expect(result.escalated).toBe(true);
    });
  });

  describe('gate decisions through pipeline', () => {
    it('gate allows SEND_TENANT ACK at Phase 1 for N-tier', () => {
      const input = makeInput({
        conversationText: 'The light bulb in the hallway is out',
        phase: 1,
        actionType: 'SEND_TENANT',
        purpose: 'ACK',
      });
      const result = runShadowPipeline(input);

      expect(result.gateOutput).not.toBeNull();
      expect(result.gateOutput!.gateResult.decision).toBe('ALLOW');
      expect(result.gateOutput!.verdict.result).toBe('PASS');
    });

    it('gate denies SEND_TENANT at Phase 0', () => {
      const input = makeInput({
        conversationText: 'The light bulb is out',
        phase: 0,
        actionType: 'SEND_TENANT',
        purpose: 'ACK',
      });
      const result = runShadowPipeline(input);

      expect(result.gateOutput).not.toBeNull();
      expect(result.gateOutput!.gateResult.decision).toBe('DENY');
      expect(result.gateOutput!.verdict.result).toBe('FAIL');
    });

    it('gate denies VENDOR_DISPATCH at any phase', () => {
      const input = makeInput({
        phase: 3,
        actionType: 'VENDOR_DISPATCH',
        purpose: 'VENDOR_DISPATCH',
      });
      const result = runShadowPipeline(input);

      expect(result.gateOutput).not.toBeNull();
      expect(result.gateOutput!.gateResult.decision).toBe('DENY');
    });

    it('gate allows WO_ASSIGNMENT at Phase 0', () => {
      const input = makeInput({
        conversationText: 'The door handle is loose',
        phase: 0,
        actionType: 'WO_ASSIGNMENT',
        purpose: 'ACK',
      });
      const result = runShadowPipeline(input);

      expect(result.gateOutput).not.toBeNull();
      expect(result.gateOutput!.gateResult.decision).toBe('ALLOW');
    });
  });

  describe('schedule reclassification through pipeline', () => {
    it('reclassifies SEND_TENANT to SCHEDULE_PROMISE when schedule detected', () => {
      const input = makeInput({
        conversationText: 'The sink is dripping',
        phase: 1,
        actionType: 'SEND_TENANT',
        purpose: 'ACK',
        messageBytes: 'We will schedule someone to come out next Tuesday at 10am.',
      });
      const result = runShadowPipeline(input);

      expect(result.gateOutput).not.toBeNull();
      if (result.gateOutput!.gateResult.reclassified) {
        expect(result.gateOutput!.gateResult.finalActionType).toBe('SCHEDULE_PROMISE');
        expect(result.gateOutput!.gateResult.decision).toBe('DENY');
      }
    });
  });

  describe('state transitions', () => {
    it('reaches READY_FOR_HUMAN on allowed action', () => {
      const input = makeInput({
        conversationText: 'Door handle is loose',
        phase: 0,
        actionType: 'WO_ASSIGNMENT',
        purpose: 'ACK',
      });
      const result = runShadowPipeline(input);

      expect(result.finalState).toBe('READY_FOR_HUMAN');
    });

    it('stays in ESCALATED if terminal invariant fires', () => {
      const input = makeInput({
        conversationText: 'There is mold in the bathroom',
      });
      const result = runShadowPipeline(input);

      expect(result.finalState).toBe('ESCALATED');
    });

    it('facts are populated after classification', () => {
      const input = makeInput({
        conversationText: 'The kitchen sink is leaking',
        tenantName: 'John Doe',
        unitId: 'Apt 2B',
      });
      const result = runShadowPipeline(input);

      expect(result.wo.facts.length).toBeGreaterThan(0);
      const systemFacts = result.wo.facts.filter(f => f.type === 'system_fact');
      expect(systemFacts.some(f => f.value.includes('WO-5000'))).toBe(true);
    });
  });
});
