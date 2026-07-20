/**
 * Google Calendar read-only wrapper for Pamela.
 * Requires calendar.readonly DWD scope authorized in Workspace Admin console.
 */

import { mintPamelaToken, CALENDAR_SCOPE } from './auth';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
  organizer: string;
}

async function calFetch(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${CALENDAR_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Calendar API error (${res.status}) ${path}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

export async function listEvents(opts: {
  calendarId?: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const token = await mintPamelaToken(CALENDAR_SCOPE);
  const { calendarId = 'primary', timeMin, timeMax, maxResults = 50 } = opts;

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const res = await calFetch(token, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`) as {
    items?: Array<Record<string, unknown>>;
  };

  return (res.items ?? []).map(item => {
    const start = item.start as Record<string, string> ?? {};
    const end = item.end as Record<string, string> ?? {};
    const attendees = (item.attendees as Array<{ email: string; displayName?: string }> ?? [])
      .map(a => a.displayName ?? a.email);
    const organizer = (item.organizer as { email: string; displayName?: string } ?? {});

    return {
      id: item.id as string ?? '',
      summary: item.summary as string ?? '(no title)',
      description: (item.description as string ?? '').slice(0, 500),
      location: item.location as string ?? '',
      start: start.dateTime ?? start.date ?? '',
      end: end.dateTime ?? end.date ?? '',
      allDay: !!start.date && !start.dateTime,
      attendees,
      organizer: organizer.displayName ?? organizer.email ?? '',
    };
  });
}

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const token = await mintPamelaToken(CALENDAR_SCOPE);
  const res = await fetch(`${CALENDAR_API}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 403 && err.includes('has not been used in project')) {
      throw new Error('Calendar API not enabled in GCP project. Rob must enable it at console.developers.google.com.');
    }
    throw new Error(`Calendar API error (${res.status}) /users/me/calendarList: ${err.slice(0, 200)}`);
  }
  const data = await res.json() as { items?: Array<Record<string, unknown>> };
  return (data.items ?? []).map(c => ({
    id: c.id as string ?? '',
    summary: c.summary as string ?? '',
    primary: c.primary as boolean ?? false,
  }));
}

function offsetAtUtcHour(y: number, m: number, d: number, utcHour: number): number {
  const probe = new Date(Date.UTC(y, m - 1, d, utcHour, 0, 0));
  const laHour = parseInt(
    probe.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }),
    10,
  );
  return utcHour - (laHour === 24 ? 0 : laHour);
}

function formatOffset(hours: number): string {
  return `-${String(hours).padStart(2, '0')}:00`;
}

export function pacificOffset(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return formatOffset(offsetAtUtcHour(y, m, d, 20));
}

export function pacificDayBounds(dateStr: string): { timeMin: string; timeMax: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startOffset = offsetAtUtcHour(y, m, d, 8);
  const endOffset = offsetAtUtcHour(y, m, d, 20);
  return {
    timeMin: `${dateStr}T00:00:00${formatOffset(startOffset)}`,
    timeMax: `${dateStr}T23:59:59${formatOffset(endOffset)}`,
  };
}

export async function getDayEvents(date: string, calendarId?: string): Promise<CalendarEvent[]> {
  const { timeMin, timeMax } = pacificDayBounds(date);
  if (calendarId) {
    return listEvents({ calendarId, timeMin, timeMax });
  }
  const result = await getAllCalendarEvents({ timeMin, timeMax });
  return result.events;
}

export interface CalendarFailure {
  calendarId: string;
  summary: string;
  error: string;
}

export interface AllCalendarResult {
  events: CalendarEvent[];
  failedCalendars: CalendarFailure[];
}

export async function getAllCalendarEvents(opts: {
  timeMin: string;
  timeMax: string;
  maxResults?: number;
  allowPartial?: boolean;
}): Promise<AllCalendarResult> {
  const calendars = await listCalendars();
  const allEvents: CalendarEvent[] = [];
  const failures: CalendarFailure[] = [];
  for (const cal of calendars) {
    try {
      const events = await listEvents({ calendarId: cal.id, timeMin: opts.timeMin, timeMax: opts.timeMax, maxResults: opts.maxResults });
      allEvents.push(...events);
    } catch (e) {
      failures.push({
        calendarId: cal.id,
        summary: cal.summary,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (failures.length > 0 && !opts.allowPartial) {
    const failedNames = failures.map(f => f.summary || f.calendarId).join(', ');
    throw new Error(`Calendar read failed for: ${failedNames}. Use allowPartial to accept incomplete results.`);
  }
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return { events: allEvents, failedCalendars: failures };
}

export function formatEventsForTelegram(events: CalendarEvent[], date: string): string {
  if (events.length === 0) return `No events on ${date}.`;

  const lines = events.map(e => {
    const time = e.allDay
      ? 'All day'
      : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
    const loc = e.location ? ` @ ${e.location}` : '';
    return `${time} — ${e.summary}${loc}`;
  });

  return `Calendar for ${date}:\n${lines.join('\n')}`;
}
