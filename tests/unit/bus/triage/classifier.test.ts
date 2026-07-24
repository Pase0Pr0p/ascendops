import { describe, it, expect } from 'vitest';
import { classify, applyClassification } from '../../../../src/bus/triage/classifier';
import type { TriageWO } from '../../../../src/bus/triage/types';

function makeWO(overrides: Partial<TriageWO> = {}): TriageWO {
  return {
    woId: 'WO-2000',
    propertyAddress: '123 Main St',
    conversationText: 'The faucet is dripping.',
    photoUrls: [],
    escalationFlags: [],
    facts: [],
    state: 'CLASSIFYING',
    ...overrides,
  };
}

describe('classifier', () => {
  describe('tier classification', () => {
    it('classifies E0 for fire', () => {
      const wo = makeWO({ conversationText: 'There is a fire in the kitchen' });
      const result = classify(wo);
      expect(result.tier).toBe('E0');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('classifies E0 for gas leak', () => {
      const wo = makeWO({ conversationText: 'I smell gas in the apartment' });
      const result = classify(wo);
      expect(result.tier).toBe('E0');
    });

    it('classifies E0 for carbon monoxide', () => {
      const wo = makeWO({ conversationText: 'Carbon monoxide alarm is going off' });
      const result = classify(wo);
      expect(result.tier).toBe('E0');
    });

    it('classifies E0 for electrical shock', () => {
      const wo = makeWO({ conversationText: 'I got an electrical shock from the outlet' });
      const result = classify(wo);
      expect(result.tier).toBe('E0');
    });

    it('classifies E1 for flooding', () => {
      const wo = makeWO({ conversationText: 'The apartment is flooding from a burst pipe' });
      const result = classify(wo);
      expect(result.tier).toBe('E1');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('classifies E1 for sewage', () => {
      const wo = makeWO({ conversationText: 'Sewage is backing up into the bathroom' });
      const result = classify(wo);
      expect(result.tier).toBe('E1');
    });

    it('classifies E1 for no heat', () => {
      const wo = makeWO({ conversationText: 'We have no heat and it is freezing' });
      const result = classify(wo);
      expect(result.tier).toBe('E1');
    });

    it('classifies E1 for broken locks', () => {
      const wo = makeWO({ conversationText: 'The front door lock is broken, cannot lock the apartment' });
      const result = classify(wo);
      expect(result.tier).toBe('E1');
    });

    it('classifies E1 for power outage', () => {
      const wo = makeWO({ conversationText: 'Power outage in the whole unit' });
      const result = classify(wo);
      expect(result.tier).toBe('E1');
    });

    it('classifies U for no hot water', () => {
      const wo = makeWO({ conversationText: 'There is no hot water since yesterday' });
      const result = classify(wo);
      expect(result.tier).toBe('U');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('classifies U for clogged drain', () => {
      const wo = makeWO({ conversationText: 'The kitchen drain is clogged and water backs up' });
      const result = classify(wo);
      expect(result.tier).toBe('U');
    });

    it('classifies U for pest infestation', () => {
      const wo = makeWO({ conversationText: 'We have roaches in the kitchen' });
      const result = classify(wo);
      expect(result.tier).toBe('U');
    });

    it('classifies U for broken appliance', () => {
      const wo = makeWO({ conversationText: 'The refrigerator is not working and food is spoiling' });
      const result = classify(wo);
      expect(result.tier).toBe('U');
    });

    it('classifies U for broken AC', () => {
      const wo = makeWO({ conversationText: 'AC not working and it is 95 degrees' });
      const result = classify(wo);
      expect(result.tier).toBe('U');
    });

    it('classifies D for preventive maintenance', () => {
      const wo = makeWO({ conversationText: 'Need to schedule preventive maintenance on HVAC' });
      const result = classify(wo);
      expect(result.tier).toBe('D');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('classifies D for landscaping', () => {
      const wo = makeWO({ conversationText: 'The landscaping in the front yard needs attention' });
      const result = classify(wo);
      expect(result.tier).toBe('D');
    });

    it('classifies D for no-rush requests', () => {
      const wo = makeWO({ conversationText: 'When you get a chance can you look at the cabinet door' });
      const result = classify(wo);
      expect(result.tier).toBe('D');
    });

    it('classifies N for generic maintenance', () => {
      const wo = makeWO({ conversationText: 'The light in the hallway is flickering' });
      const result = classify(wo);
      expect(result.tier).toBe('N');
    });

    it('classifies N for minimal text', () => {
      const wo = makeWO({ conversationText: 'door handle loose' });
      const result = classify(wo);
      expect(result.tier).toBe('N');
    });
  });

  describe('escalation flag detection', () => {
    it('detects VULNERABLE_OCCUPANT for elderly', () => {
      const wo = makeWO({ conversationText: 'The elderly tenant in unit 5 has a leak' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('VULNERABLE_OCCUPANT');
    });

    it('detects VULNERABLE_OCCUPANT for disabled', () => {
      const wo = makeWO({ conversationText: 'Tenant is disabled and uses a wheelchair' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('VULNERABLE_OCCUPANT');
    });

    it('detects VULNERABLE_OCCUPANT for children', () => {
      const wo = makeWO({ conversationText: 'We have children in the unit with no heat' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('VULNERABLE_OCCUPANT');
    });

    it('detects TENANT_FRICTION for angry tenant', () => {
      const wo = makeWO({ conversationText: 'Tenant is very angry about the leak' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('TENANT_FRICTION');
    });

    it('detects TENANT_FRICTION for lawyer mention', () => {
      const wo = makeWO({ conversationText: 'Tenant says they will call their lawyer' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('TENANT_FRICTION');
    });

    it('detects REPEAT_FAILURE for recurring issue', () => {
      const wo = makeWO({ conversationText: 'This is the third time this same issue has happened' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('REPEAT_FAILURE');
    });

    it('detects CROSS_UNIT_ENTRY for neighbor leak', () => {
      const wo = makeWO({ conversationText: 'Water is leaking from the upstairs unit into ours' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('CROSS_UNIT_ENTRY');
    });

    it('detects ACCESS_REFUSAL', () => {
      const wo = makeWO({ conversationText: 'Tenant refused entry for the inspection' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('ACCESS_REFUSAL');
    });

    it('detects LEGAL_HABITABILITY', () => {
      const wo = makeWO({ conversationText: 'This is a habitability issue and we will withhold rent' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('LEGAL_HABITABILITY');
    });

    it('detects AMBIGUOUS_DIAGNOSIS', () => {
      const wo = makeWO({ conversationText: 'We are not sure what is causing the leak' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('AMBIGUOUS_DIAGNOSIS');
    });

    it('detects OWNER_DIRECTED_WORK', () => {
      const wo = makeWO({ conversationText: 'The owner requested the landscaping be redone' });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('OWNER_DIRECTED_WORK');
    });

    it('detects multiple flags', () => {
      const wo = makeWO({
        conversationText: 'The elderly tenant is angry and threatening to call a lawyer about the repeated leak from the upstairs unit',
      });
      const result = classify(wo);
      expect(result.escalationFlags).toContain('VULNERABLE_OCCUPANT');
      expect(result.escalationFlags).toContain('TENANT_FRICTION');
      expect(result.escalationFlags).toContain('CROSS_UNIT_ENTRY');
    });

    it('returns empty flags for clean text', () => {
      const wo = makeWO({ conversationText: 'The light in the hallway is flickering' });
      const result = classify(wo);
      expect(result.escalationFlags).toHaveLength(0);
    });
  });

  describe('fact extraction', () => {
    it('extracts system facts from WO metadata', () => {
      const wo = makeWO({
        tenantName: 'Jane Doe',
        unitId: 'Unit 4B',
      });
      const result = classify(wo);
      const systemFacts = result.facts.filter(f => f.type === 'system_fact');
      expect(systemFacts.length).toBeGreaterThanOrEqual(3);
      expect(systemFacts.some(f => f.value.includes('WO-2000'))).toBe(true);
      expect(systemFacts.some(f => f.value.includes('Jane Doe'))).toBe(true);
      expect(systemFacts.some(f => f.value.includes('Unit 4B'))).toBe(true);
    });

    it('extracts location as inference from text', () => {
      const wo = makeWO({ conversationText: 'The kitchen sink is leaking under the counter' });
      const result = classify(wo);
      const inferences = result.facts.filter(f => f.type === 'inference' && f.value.includes('location'));
      expect(inferences.length).toBe(1);
      expect(inferences[0].value).toContain('kitchen');
      expect(inferences[0].confidence).toBeLessThan(1.0);
    });

    it('labels negated location as NOT location with low confidence', () => {
      const wo = makeWO({ conversationText: 'The leak is not in the kitchen; it may be upstairs' });
      const result = classify(wo);
      const inferences = result.facts.filter(f => f.type === 'inference' && f.value.includes('location'));
      expect(inferences.length).toBe(1);
      expect(inferences[0].value).toContain('NOT location');
      expect(inferences[0].confidence).toBeLessThanOrEqual(0.3);
    });

    it('extracts vision observation', () => {
      const wo = makeWO({ visionAnalysis: 'Photo shows water staining on ceiling' });
      const result = classify(wo);
      const visionFacts = result.facts.filter(f => f.type === 'vision_observation');
      expect(visionFacts.length).toBe(1);
      expect(visionFacts[0].value).toBe('Photo shows water staining on ceiling');
    });

    it('assigns confidence 1.0 to system facts', () => {
      const wo = makeWO();
      const result = classify(wo);
      const systemFacts = result.facts.filter(f => f.type === 'system_fact');
      for (const fact of systemFacts) {
        expect(fact.confidence).toBe(1.0);
      }
    });
  });

  describe('sufficiency assessment', () => {
    it('returns EMERGENCY_OVERRIDE for E0', () => {
      const wo = makeWO({ conversationText: 'There is a fire in the building' });
      const result = classify(wo);
      expect(result.sufficiency).toBe('EMERGENCY_OVERRIDE');
    });

    it('returns NEEDS_CLARIFICATION for very short text', () => {
      const wo = makeWO({ conversationText: 'help' });
      const result = classify(wo);
      expect(result.sufficiency).toBe('NEEDS_CLARIFICATION');
    });

    it('returns NEEDS_PHOTOS for visual issue without photos', () => {
      const wo = makeWO({
        conversationText: 'There is water damage on the ceiling with a big crack',
        photoUrls: [],
      });
      const result = classify(wo);
      expect(result.sufficiency).toBe('NEEDS_PHOTOS');
    });

    it('returns CLEAR when photos are provided for visual issue', () => {
      const wo = makeWO({
        conversationText: 'There is water damage on the ceiling with a big crack',
        photoUrls: ['https://example.com/photo1.jpg'],
      });
      const result = classify(wo);
      expect(result.sufficiency).toBe('CLEAR');
    });

    it('returns CLEAR for non-visual normal issue', () => {
      const wo = makeWO({ conversationText: 'The hallway light has been flickering for two days' });
      const result = classify(wo);
      expect(result.sufficiency).toBe('CLEAR');
    });
  });

  describe('applyClassification', () => {
    it('sets tier on WO', () => {
      const wo = makeWO();
      const result = classify(wo);
      applyClassification(wo, result);
      expect(wo.tier).toBe(result.tier);
    });

    it('merges escalation flags without duplicates', () => {
      const wo = makeWO({
        conversationText: 'Elderly tenant is angry',
        escalationFlags: ['VULNERABLE_OCCUPANT'],
      });
      const result = classify(wo);
      applyClassification(wo, result);
      const count = wo.escalationFlags.filter(f => f === 'VULNERABLE_OCCUPANT').length;
      expect(count).toBe(1);
    });

    it('appends facts to WO', () => {
      const wo = makeWO();
      const initialFactCount = wo.facts.length;
      const result = classify(wo);
      applyClassification(wo, result);
      expect(wo.facts.length).toBe(initialFactCount + result.facts.length);
    });
  });
});
