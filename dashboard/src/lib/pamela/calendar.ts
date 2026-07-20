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

export async function getDayEvents(date: string, calendarId?: string): Promise<CalendarEvent[]> {
  const timeMin = `${date}T00:00:00-07:00`;
  const timeMax = `${date}T23:59:59-07:00`;
  if (calendarId) {
    return listEvents({ calendarId, timeMin, timeMax });
  }
  return getAllCalendarEvents({ timeMin, timeMax });
}

export async function getAllCalendarEvents(opts: {
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<CalendarEvent[]> {
  const calendars = await listCalendars();
  const allEvents: CalendarEvent[] = [];
  let successes = 0;
  let lastError: Error | null = null;
  for (const cal of calendars) {
    try {
      const events = await listEvents({ calendarId: cal.id, ...opts });
      allEvents.push(...events);
      successes++;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (successes === 0 && calendars.length > 0) {
    throw lastError ?? new Error('All calendar reads failed but no error was captured');
  }
  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return allEvents;
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
