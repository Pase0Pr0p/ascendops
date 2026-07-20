import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pacificOffset } from '../calendar';

describe('pacificOffset', () => {
  it('returns -07:00 during PDT (summer)', () => {
    expect(pacificOffset('2026-07-15')).toBe('-07:00');
  });

  it('returns -08:00 during PST (winter)', () => {
    expect(pacificOffset('2026-12-15')).toBe('-08:00');
  });

  it('returns -07:00 the day after spring-forward (Mar 8 2026)', () => {
    expect(pacificOffset('2026-03-09')).toBe('-07:00');
  });

  it('returns -08:00 the day after fall-back (Nov 1 2026)', () => {
    expect(pacificOffset('2026-11-02')).toBe('-08:00');
  });

  it('returns -08:00 on Jan 1', () => {
    expect(pacificOffset('2026-01-01')).toBe('-08:00');
  });

  it('returns -07:00 on Jun 21 (summer solstice)', () => {
    expect(pacificOffset('2026-06-21')).toBe('-07:00');
  });
});

vi.mock('../auth', () => ({
  mintPamelaToken: vi.fn().mockResolvedValue('mock-token'),
  CALENDAR_SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  GMAIL_SCOPE: 'https://www.googleapis.com/auth/gmail.readonly',
}));

function mockFetch(handler: (url: string) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = handler(url);
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  });
}

function mockFetchWithErrors(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const result = handler(url);
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    } as Response;
  });
}

describe('getAllCalendarEvents', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('fail-closed: throws when any calendar read fails (default)', async () => {
    const { getAllCalendarEvents } = await import('../calendar');

    fetchSpy = mockFetchWithErrors((url) => {
      if (url.includes('calendarList')) {
        return { ok: true, status: 200, body: { items: [
          { id: 'cal1', summary: 'Work', primary: true },
          { id: 'cal2', summary: 'Personal', primary: false },
        ] } };
      }
      if (url.includes(encodeURIComponent('cal2'))) {
        return { ok: false, status: 403, body: { error: 'forbidden' } };
      }
      return { ok: true, status: 200, body: { items: [
        { id: 'e1', summary: 'Meeting', start: { dateTime: '2026-07-15T10:00:00-07:00' }, end: { dateTime: '2026-07-15T11:00:00-07:00' } },
      ] } };
    });

    await expect(
      getAllCalendarEvents({ timeMin: '2026-07-15T00:00:00-07:00', timeMax: '2026-07-15T23:59:59-07:00' }),
    ).rejects.toThrow('Calendar read failed for: Personal');
  });

  it('allowPartial: returns events + failedCalendars when partial is allowed', async () => {
    const { getAllCalendarEvents } = await import('../calendar');

    fetchSpy = mockFetchWithErrors((url) => {
      if (url.includes('calendarList')) {
        return { ok: true, status: 200, body: { items: [
          { id: 'cal1', summary: 'Work', primary: true },
          { id: 'cal2', summary: 'Personal', primary: false },
        ] } };
      }
      if (url.includes(encodeURIComponent('cal2'))) {
        return { ok: false, status: 403, body: { error: 'forbidden' } };
      }
      return { ok: true, status: 200, body: { items: [
        { id: 'e1', summary: 'Meeting', start: { dateTime: '2026-07-15T10:00:00-07:00' }, end: { dateTime: '2026-07-15T11:00:00-07:00' } },
      ] } };
    });

    const result = await getAllCalendarEvents({
      timeMin: '2026-07-15T00:00:00-07:00',
      timeMax: '2026-07-15T23:59:59-07:00',
      allowPartial: true,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].summary).toBe('Meeting');
    expect(result.failedCalendars).toHaveLength(1);
    expect(result.failedCalendars[0].calendarId).toBe('cal2');
    expect(result.failedCalendars[0].summary).toBe('Personal');
  });

  it('returns empty failedCalendars when all calendars succeed', async () => {
    const { getAllCalendarEvents } = await import('../calendar');

    fetchSpy = mockFetch((url) => {
      if (url.includes('calendarList')) {
        return { items: [{ id: 'cal1', summary: 'Work', primary: true }] };
      }
      return { items: [
        { id: 'e1', summary: 'Meeting', start: { dateTime: '2026-07-15T10:00:00-07:00' }, end: { dateTime: '2026-07-15T11:00:00-07:00' } },
      ] };
    });

    const result = await getAllCalendarEvents({
      timeMin: '2026-07-15T00:00:00-07:00',
      timeMax: '2026-07-15T23:59:59-07:00',
    });

    expect(result.events).toHaveLength(1);
    expect(result.failedCalendars).toHaveLength(0);
  });
});
