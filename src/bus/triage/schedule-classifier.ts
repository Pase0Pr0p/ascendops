import type { ActionType } from './types.js';

const SCHEDULE_PATTERNS: RegExp[] = [
  /\bscheduled\b/i,
  /\bwill\s+(be\s+)?(there|come|arrive|visit|stop\s+by|show\s+up)\b/i,
  /\b(coming|arriving|visiting)\s+(on|at|by|between|around)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(morning|afternoon|evening|at\s+\d)/i,
  /\b(tomorrow|today|next\s+week)\s+(morning|afternoon|evening|at\s+\d)/i,
  /\b(between|from)\s+\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\s*(and|to|-)\s*\d{1,2}/i,
  /\bat\s+\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b/i,
  /\bexpect\s+(someone|a\s+tech|a\s+plumber|a\s+vendor|maintenance|our\s+team)\b/i,
  /\bwe('ll|.will)\s+(send|dispatch|have)\s+(someone|a\s+tech|a\s+vendor|maintenance)\b/i,
  /\b(eta|arrival)\s*(is|:)\s*/i,
];

export interface ScheduleClassifyResult {
  isSchedulePromise: boolean;
  matches: string[];
}

export function classifySchedulePromise(messageContent: string): ScheduleClassifyResult {
  const matches: string[] = [];
  for (const pattern of SCHEDULE_PATTERNS) {
    const match = pattern.exec(messageContent);
    if (match) {
      matches.push(match[0]);
    }
  }
  return { isSchedulePromise: matches.length > 0, matches };
}

export function reclassifyIfSchedule(messageContent: string, currentType: ActionType): ActionType {
  if (currentType === 'SEND_TENANT' || currentType === 'SEND_VENDOR') {
    const result = classifySchedulePromise(messageContent);
    if (result.isSchedulePromise) {
      return 'SCHEDULE_PROMISE';
    }
  }
  return currentType;
}
