/**
 * pamela-read.ts — Read-only Gmail + Calendar CLI for Pamela.
 *
 * Usage:
 *   npx tsx scripts/pamela-read.ts inbox [--max N] [--unread]
 *   npx tsx scripts/pamela-read.ts search-mail --query "<search>" [--max N]
 *   npx tsx scripts/pamela-read.ts read-mail --id <messageId>
 *   npx tsx scripts/pamela-read.ts today
 *   npx tsx scripts/pamela-read.ts calendar --date YYYY-MM-DD [--days N]
 *   npx tsx scripts/pamela-read.ts list-calendars
 *   npx tsx scripts/pamela-read.ts summary [--max-messages N] [--date YYYY-MM-DD]
 *
 * Required env (secrets.env):
 *   GOOGLE_CONTACTS_SA_KEY_PATH  — SA key
 *   PAMELA_GMAIL_SUBJECT         — Rob@paseopropertymanagement.com
 */

import '../src/lib/config';
import { listInboxMessages, getInboxSummary } from '../src/lib/pamela/gmail';
import {
  listEvents, getDayEvents,
  listCalendars, formatEventsForTelegram,
  type CalendarEvent,
} from '../src/lib/pamela/calendar';
import { mintPamelaToken, GMAIL_SCOPE } from '../src/lib/pamela/auth';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';

function argVal(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function todayPT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function main() {
  switch (command) {
    case 'inbox': {
      const max = parseInt(argVal('--max') ?? '15', 10);
      const unread = args.includes('--unread');
      const messages = await listInboxMessages({
        maxResults: max,
        query: 'in:inbox',
        unreadOnly: unread,
      });
      console.log(JSON.stringify({
        count: messages.length,
        unread_count: messages.filter(m => m.isUnread).length,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          date: m.date,
          snippet: m.snippet,
          is_unread: m.isUnread,
        })),
      }, null, 2));
      break;
    }

    case 'search-mail': {
      const query = argVal('--query');
      if (!query) {
        console.error('Usage: search-mail --query "<search>" [--max N]');
        process.exit(1);
      }
      const max = parseInt(argVal('--max') ?? '10', 10);
      const messages = await listInboxMessages({ maxResults: max, query });
      console.log(JSON.stringify({
        query,
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          date: m.date,
          snippet: m.snippet,
          is_unread: m.isUnread,
        })),
      }, null, 2));
      break;
    }

    case 'read-mail': {
      const msgId = argVal('--id');
      if (!msgId) {
        console.error('Usage: read-mail --id <messageId>');
        process.exit(1);
      }
      const token = await mintPamelaToken(GMAIL_SCOPE);
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const err = await res.text();
        console.error(`Gmail API error (${res.status}): ${err.slice(0, 200)}`);
        process.exit(1);
      }
      const msg = await res.json() as Record<string, unknown>;
      const headers = ((msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) ?? [];
      const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      function extractBody(payload: Record<string, unknown>): string {
        const mimeType = payload.mimeType as string ?? '';
        const body = payload.body as Record<string, unknown> ?? {};
        if (mimeType === 'text/plain' && body.data) {
          return Buffer.from(body.data as string, 'base64url').toString('utf8');
        }
        const parts = payload.parts as Array<Record<string, unknown>> ?? [];
        for (const p of parts) {
          const found = extractBody(p);
          if (found) return found;
        }
        return '';
      }

      console.log(JSON.stringify({
        id: msg.id,
        threadId: msg.threadId,
        from: getHeader('from'),
        to: getHeader('to'),
        cc: getHeader('cc'),
        subject: getHeader('subject'),
        date: getHeader('date'),
        is_unread: ((msg.labelIds as string[]) ?? []).includes('UNREAD'),
        body: extractBody(msg.payload as Record<string, unknown>).slice(0, 5000),
      }, null, 2));
      break;
    }

    case 'today': {
      const date = todayPT();
      const events = await getDayEvents(date);
      if (events.length === 0) {
        console.log(JSON.stringify({ date, events: [], message: 'No events today across all calendars.' }, null, 2));
      } else {
        console.log(JSON.stringify({ date, count: events.length, events }, null, 2));
      }
      break;
    }

    case 'calendar': {
      const date = argVal('--date') ?? todayPT();
      const days = parseInt(argVal('--days') ?? '1', 10);
      const allEvents: CalendarEvent[] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(`${date}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        const dayStr = d.toISOString().slice(0, 10);
        const dayEvents = await getDayEvents(dayStr);
        allEvents.push(...dayEvents);
      }
      console.log(JSON.stringify({
        date_range: { from: date, days },
        count: allEvents.length,
        events: allEvents,
      }, null, 2));
      break;
    }

    case 'list-calendars': {
      const calendars = await listCalendars();
      console.log(JSON.stringify({
        count: calendars.length,
        calendars: calendars.map(c => ({
          id: c.id,
          name: c.summary,
          primary: c.primary,
        })),
      }, null, 2));
      break;
    }

    case 'summary': {
      const maxMessages = parseInt(argVal('--max-messages') ?? '15', 10);
      const date = argVal('--date') ?? todayPT();

      const [messages, events] = await Promise.all([
        listInboxMessages({ maxResults: maxMessages, query: 'in:inbox' }),
        getDayEvents(date),
      ]);

      const calSummary = formatEventsForTelegram(events, date);
      const unreadCount = messages.filter(m => m.isUnread).length;

      console.log(JSON.stringify({
        calendar: { date, event_count: events.length, formatted: calSummary },
        inbox: {
          shown: messages.length,
          unread: unreadCount,
          messages: messages.map(m => ({
            id: m.id,
            from: m.from,
            subject: m.subject,
            date: m.date,
            snippet: m.snippet,
            is_unread: m.isUnread,
          })),
        },
      }, null, 2));
      break;
    }

    default:
      console.log([
        'Usage: pamela-read.ts <command> [options]',
        '',
        'Commands:',
        '  inbox [--max N] [--unread]                  — list inbox messages',
        '  search-mail --query "<search>" [--max N]    — search Gmail',
        '  read-mail --id <messageId>                  — read full message',
        '  today                                       — today\'s events (all calendars)',
        '  calendar --date YYYY-MM-DD [--days N]       — events for date range (all calendars)',
        '  list-calendars                              — list available calendars',
        '  summary [--max-messages N] [--date YYYY-MM-DD] — inbox + calendar summary',
      ].join('\n'));
      process.exit(command === 'help' ? 0 : 1);
  }
}

main().catch(err => {
  console.error('[pamela-read] error:', err.message);
  process.exit(1);
});
