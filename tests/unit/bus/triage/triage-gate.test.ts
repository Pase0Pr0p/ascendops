import { describe, it, expect } from 'vitest';
import { triageGate } from '../../../../src/bus/triage/triage-gate';

describe('triage-gate composed production entry', () => {
  describe('schedule content → classifier → permanent deny (end-to-end)', () => {
    it('SEND_TENANT with schedule promise hits permanent deny via reclassification', () => {
      const result = triageGate(
        1, 'N', 'ACK', 'SEND_TENANT',
        'Hi! A technician has been scheduled for Tuesday at 2pm.',
      );
      expect(result.decision).toBe('DENY');
      expect(result.reclassified).toBe(true);
      expect(result.finalActionType).toBe('SCHEDULE_PROMISE');
      expect(result.rule).toBe('permanent-deny');
    });

    it('SEND_TENANT with arrival promise hits permanent deny', () => {
      const result = triageGate(
        2, 'N', 'ACK', 'SEND_TENANT',
        'Our maintenance team will be there between 9am and 11am tomorrow.',
      );
      expect(result.decision).toBe('DENY');
      expect(result.reclassified).toBe(true);
      expect(result.finalActionType).toBe('SCHEDULE_PROMISE');
      expect(result.rule).toBe('permanent-deny');
    });

    it('SEND_VENDOR with schedule content hits permanent deny', () => {
      const result = triageGate(
        1, 'N', 'ACK', 'SEND_VENDOR',
        'Please arrive at the property at 3pm on Wednesday.',
      );
      expect(result.decision).toBe('DENY');
      expect(result.reclassified).toBe(true);
      expect(result.finalActionType).toBe('SCHEDULE_PROMISE');
      expect(result.rule).toBe('permanent-deny');
    });
  });

  describe('non-schedule content passes through normally', () => {
    it('SEND_TENANT ACK without schedule content is allowed in Phase 1', () => {
      const result = triageGate(
        1, 'N', 'ACK', 'SEND_TENANT',
        'Thank you for reporting the issue. We are looking into it.',
      );
      expect(result.decision).toBe('ALLOW');
      expect(result.reclassified).toBe(false);
      expect(result.finalActionType).toBe('SEND_TENANT');
    });

    it('SEND_TENANT INFO_REQUEST without schedule content is allowed in Phase 1', () => {
      const result = triageGate(
        1, 'N', 'INFO_REQUEST', 'SEND_TENANT',
        'Could you please send photos of the leak?',
      );
      expect(result.decision).toBe('ALLOW');
      expect(result.reclassified).toBe(false);
    });
  });

  describe('terminal invariant flags still deny through gate', () => {
    it('MOLD_ESCALATE denies even simple ACK', () => {
      const result = triageGate(
        1, 'N', 'ACK', 'SEND_TENANT',
        'We received your report.',
        ['MOLD_ESCALATE'],
      );
      expect(result.decision).toBe('DENY');
      expect(result.rule).toBe('terminal-invariant');
    });
  });

  describe('permanent denies still enforced through gate', () => {
    it('VENDOR_DISPATCH denied regardless of content', () => {
      const result = triageGate(
        1, 'N', 'VENDOR_DISPATCH', 'VENDOR_DISPATCH',
        'Sending vendor to site.',
      );
      expect(result.decision).toBe('DENY');
      expect(result.rule).toBe('permanent-deny');
    });
  });

  describe('non-SEND action types are NOT reclassified', () => {
    it('INTERNAL_NOTE_REVIEWED with schedule text stays INTERNAL_NOTE_REVIEWED', () => {
      const result = triageGate(
        1, 'N', 'ACK', 'INTERNAL_NOTE_REVIEWED',
        'Scheduled plumber for Tuesday.',
      );
      expect(result.decision).toBe('ALLOW');
      expect(result.reclassified).toBe(false);
      expect(result.finalActionType).toBe('INTERNAL_NOTE_REVIEWED');
    });
  });
});
