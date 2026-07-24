import { describe, it, expect } from 'vitest';
import { detectMold, detectMoldInText, detectMoldInVision } from '../../../../src/bus/triage/mold-detection';

describe('mold detection', () => {
  describe('text detection', () => {
    const positives = [
      'There is mold on the wall',
      'I see mould in the bathroom',
      'Mildew on the shower tiles',
      'black spots on the ceiling',
      'dark spots on the wall near the window',
      'musty smell in the closet',
      'damp growth on the baseboard',
      'I think there is fungal growth behind the cabinet',
      'the grout is moldy',
      'molds are growing on the window frame',
      'MOLD EVERYWHERE',
      'there is mildew around the tub',
      'water damage with discoloration on wall',
      'damp stain on the ceiling',
    ];

    for (const text of positives) {
      it(`detects: "${text}"`, () => {
        const result = detectMoldInText(text);
        expect(result.detected).toBe(true);
        expect(result.matches.length).toBeGreaterThan(0);
      });
    }

    const negatives = [
      'The door molding is broken',
      'I need a new light switch',
      'The faucet is leaking',
      'Garbage disposal not working',
      'AC is not cooling',
      '',
    ];

    for (const text of negatives) {
      it(`does not false-trigger: "${text}"`, () => {
        const result = detectMoldInText(text);
        expect(result.detected).toBe(false);
      });
    }
  });

  describe('vision detection', () => {
    it('detects mold keywords in vision analysis', () => {
      const result = detectMoldInVision('Image shows dark discoloration consistent with mold growth on ceiling');
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('HIGH');
    });

    it('marks ambiguous vision as AMBIGUOUS but still detected', () => {
      const result = detectMoldInVision('Possible mold, uncertain dark patches on wall');
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('AMBIGUOUS');
    });

    it('does not detect when no mold keywords', () => {
      const result = detectMoldInVision('Image shows a cracked window frame with peeling paint');
      expect(result.detected).toBe(false);
    });

    it('handles empty input', () => {
      const result = detectMoldInVision('');
      expect(result.detected).toBe(false);
    });
  });

  describe('combined detection', () => {
    it('returns HIGH when both text and vision match', () => {
      const result = detectMold('There is mold on the wall', 'Image confirms mold growth');
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('HIGH');
      expect(result.source).toBe('both');
    });

    it('detects from text only', () => {
      const result = detectMold('black spots on the ceiling');
      expect(result.detected).toBe(true);
      expect(result.source).toBe('text');
    });

    it('detects from vision only (ambiguous still escalates)', () => {
      const result = detectMold('The sink is clogged', 'Possible mold in corner');
      expect(result.detected).toBe(true);
      expect(result.source).toBe('vision');
    });

    it('returns NONE when neither matches', () => {
      const result = detectMold('The faucet drips', 'Image shows a dripping faucet');
      expect(result.detected).toBe(false);
    });
  });
});
