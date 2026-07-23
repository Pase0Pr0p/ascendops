import { describe, it, expect } from 'vitest';
import { classifySchedulePromise, reclassifyIfSchedule } from '../../../../src/bus/triage/schedule-classifier';

describe('schedule-promise classifier', () => {
  describe('classifySchedulePromise', () => {
    const positives = [
      'We have scheduled a plumber for Tuesday morning',
      'A technician will be there between 9am and 11am',
      'Someone will come on Thursday at 2pm',
      'Maintenance will arrive by tomorrow afternoon',
      'We will send someone to look at it',
      "We'll have a tech come by next week afternoon",
      'Expect a plumber between 10:00am and 12pm',
      'Your repair is scheduled for Monday at 3pm',
      'Our team arriving on Friday morning',
      'ETA is 2pm',
    ];

    for (const text of positives) {
      it(`detects schedule promise: "${text}"`, () => {
        const result = classifySchedulePromise(text);
        expect(result.isSchedulePromise).toBe(true);
        expect(result.matches.length).toBeGreaterThan(0);
      });
    }

    const negatives = [
      'Thank you for reporting the issue, we are looking into it.',
      'Can you send photos of the leak?',
      'Your work order has been created.',
      'We need more information about the problem.',
      'The issue has been documented.',
    ];

    for (const text of negatives) {
      it(`does not false-positive on: "${text}"`, () => {
        const result = classifySchedulePromise(text);
        expect(result.isSchedulePromise).toBe(false);
      });
    }
  });

  describe('reclassifyIfSchedule', () => {
    it('reclassifies SEND_TENANT with schedule content to SCHEDULE_PROMISE', () => {
      const result = reclassifyIfSchedule('We have scheduled a tech for Tuesday', 'SEND_TENANT');
      expect(result).toBe('SCHEDULE_PROMISE');
    });

    it('reclassifies SEND_VENDOR with schedule content to SCHEDULE_PROMISE', () => {
      const result = reclassifyIfSchedule('Technician will arrive at 2pm', 'SEND_VENDOR');
      expect(result).toBe('SCHEDULE_PROMISE');
    });

    it('does NOT reclassify SEND_TENANT without schedule content', () => {
      const result = reclassifyIfSchedule('Thank you for reporting the issue', 'SEND_TENANT');
      expect(result).toBe('SEND_TENANT');
    });

    it('does NOT reclassify non-send action types even with schedule content', () => {
      const result = reclassifyIfSchedule('Scheduled for Tuesday', 'WO_ASSIGNMENT');
      expect(result).toBe('WO_ASSIGNMENT');
    });

    it('does NOT reclassify INTERNAL_NOTE_REVIEWED even with schedule content', () => {
      const result = reclassifyIfSchedule('Scheduled for Tuesday', 'INTERNAL_NOTE_REVIEWED');
      expect(result).toBe('INTERNAL_NOTE_REVIEWED');
    });
  });
});
