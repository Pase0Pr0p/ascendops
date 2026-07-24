import { describe, it, expect } from 'vitest';
import { validateContent } from '../../../../src/bus/triage/content-validator';

describe('content-validator', () => {
  describe('denylist: internal classification labels', () => {
    it('rejects tier labels', () => {
      const result = validateContent('Your request is tier N', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('internal-classification-label');
    });

    it('rejects trade labels', () => {
      const result = validateContent('This is trade PLUMBING work', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects priority labels', () => {
      const result = validateContent('This is priority: low', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects classified-as phrasing', () => {
      const result = validateContent('We classified your request as routine', 'ACK');
      expect(result.valid).toBe(false);
    });
  });

  describe('denylist: responsibility/chargeback', () => {
    it('rejects "your fault" language', () => {
      const result = validateContent('This is your fault', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('responsibility-or-chargeback');
    });

    it('rejects "you will be charged"', () => {
      const result = validateContent('You will be charged for the repair', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects tenant-caused language', () => {
      const result = validateContent('This is a tenant-caused issue', 'INFO_REQUEST');
      expect(result.valid).toBe(false);
    });

    it('rejects "the bill is yours" paraphrase', () => {
      const result = validateContent('The repair bill is yours.', 'ACK');
      expect(result.valid).toBe(false);
    });
  });

  describe('denylist: entry/access authority', () => {
    it('rejects "we have permission"', () => {
      const result = validateContent('We have permission to enter', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('entry-or-access-authority');
    });

    it('rejects "we will enter your unit"', () => {
      const result = validateContent('We will enter your unit on Monday', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects forced entry language', () => {
      const result = validateContent('We may need to force entry', 'INFO_REQUEST');
      expect(result.valid).toBe(false);
    });

    it('rejects "let ourselves into" paraphrase', () => {
      const result = validateContent('We can let ourselves into the apartment.', 'ACK');
      expect(result.valid).toBe(false);
    });
  });

  describe('denylist: schedule promises', () => {
    it('rejects "your appointment is"', () => {
      const result = validateContent('Your appointment is Friday', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('schedule-promise');
    });

    it('rejects "scheduled for"', () => {
      const result = validateContent('Maintenance is scheduled for next week', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects "we will come"', () => {
      const result = validateContent('We will come to inspect tomorrow', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects "technician is booked Friday" paraphrase', () => {
      const result = validateContent('The technician is booked Friday.', 'ACK');
      expect(result.valid).toBe(false);
    });

    it('rejects day+time scheduling', () => {
      const result = validateContent('A plumber will arrive Tuesday at 3pm', 'ACK');
      expect(result.valid).toBe(false);
    });
  });

  describe('denylist: legal/health commitments', () => {
    it('rejects habitability claims', () => {
      const result = validateContent('This is a habitability concern', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('legal-or-health-commitment');
    });

    it('rejects code violation references', () => {
      const result = validateContent('This may be a code violation', 'INFO_REQUEST');
      expect(result.valid).toBe(false);
    });

    it('rejects health hazard claims', () => {
      const result = validateContent('This is a health hazard', 'ACK');
      expect(result.valid).toBe(false);
    });
  });

  describe('allowlist: ACK templates', () => {
    it('allows "Thank you for letting us know"', () => {
      const result = validateContent('Thank you for letting us know. We have received your request.', 'ACK');
      expect(result.valid).toBe(true);
    });

    it('allows "We have received your maintenance request"', () => {
      const result = validateContent('We have received your maintenance request and will look into it shortly.', 'ACK');
      expect(result.valid).toBe(true);
    });

    it('allows "Your request has been received"', () => {
      const result = validateContent('Your request has been received and logged.', 'ACK');
      expect(result.valid).toBe(true);
    });

    it('allows "Acknowledged"', () => {
      const result = validateContent('Acknowledged', 'ACK');
      expect(result.valid).toBe(true);
    });

    it('rejects free-form ACK content not in allowlist', () => {
      const result = validateContent('Sounds good, we are on it.', 'ACK');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('content-not-in-template');
    });
  });

  describe('allowlist: INFO_REQUEST templates', () => {
    it('allows "Could you provide photos"', () => {
      const result = validateContent('Could you provide photos of the issue?', 'INFO_REQUEST');
      expect(result.valid).toBe(true);
    });

    it('allows "What is the unit number"', () => {
      const result = validateContent('What is the unit number?', 'INFO_REQUEST');
      expect(result.valid).toBe(true);
    });

    it('allows "Please send us a photo"', () => {
      const result = validateContent('Please send us a photo of the damage.', 'INFO_REQUEST');
      expect(result.valid).toBe(true);
    });

    it('rejects free-form INFO_REQUEST not in allowlist', () => {
      const result = validateContent('Tell me more about it.', 'INFO_REQUEST');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('content-not-in-template');
    });
  });

  describe('allowlist: DIY_OFFER templates', () => {
    it('allows "You might try resetting the breaker"', () => {
      const result = validateContent('You might try resetting the breaker switch.', 'DIY_OFFER');
      expect(result.valid).toBe(true);
    });

    it('allows "Try the reset button"', () => {
      const result = validateContent('Try the reset button on the disposal.', 'DIY_OFFER');
      expect(result.valid).toBe(true);
    });

    it('rejects free-form DIY_OFFER not in allowlist', () => {
      const result = validateContent('Just fix it yourself.', 'DIY_OFFER');
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('content-not-in-template');
    });
  });

  describe('non-tenant purposes skip validation', () => {
    it('allows any content for ESCALATION purpose', () => {
      const result = validateContent('This is tier E0 emergency, your fault, habitability issue', 'ESCALATION');
      expect(result.valid).toBe(true);
    });

    it('allows any content for VENDOR_DISPATCH purpose', () => {
      const result = validateContent('Schedule plumber for Tuesday at 10am', 'VENDOR_DISPATCH');
      expect(result.valid).toBe(true);
    });
  });

  describe('multiple violations', () => {
    it('catches all denylist violations in a single message', () => {
      const result = validateContent(
        'We classified your request as tier N and low priority. This is your fault. We will enter your unit. Your appointment is Friday.',
        'ACK',
      );
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('denylist takes precedence over allowlist', () => {
    it('denylisted content fails even if it matches allowlist shape', () => {
      const result = validateContent('We have received your low priority request.', 'ACK');
      expect(result.valid).toBe(false);
    });
  });
});
