/**
 * pamela-inbox-summary.ts
 *
 * Pulls Rob's Gmail inbox + today's calendar and prints a formatted summary.
 * Called by Pamela's cron or on-demand.
 *
 * Usage:
 *   npx tsx scripts/pamela-inbox-summary.ts [--max-messages N] [--date YYYY-MM-DD]
 *
 * Required env (secrets.env):
 *   GOOGLE_CONTACTS_SA_KEY_PATH  — SA key (gmail.readonly + calendar.readonly DWD scopes must be authorized)
 *   PAMELA_GMAIL_SUBJECT         — Rob@paseopropertymanagement.com
 */

import '../src/lib/config';
import { listInboxMessages } from '../src/lib/pamela/gmail';
import { getDayEvents, formatEventsForTelegram } from '../src/lib/pamela/calendar';

const args = process.argv.slice(2);
const maxIdx = args.indexOf('--max-messages');
const maxMessages = maxIdx >= 0 ? parseInt(args[maxIdx + 1] ?? '15', 10) : 15;
const dateIdx = args.indexOf('--date');
const targetDate = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

async function main() {
  console.log(`[pamela] fetching inbox (max ${maxMessages}) + calendar for ${targetDate}...`);

  const [messages, events] = await Promise.all([
    listInboxMessages({ maxResults: maxMessages, query: 'in:inbox' }),
    getDayEvents(targetDate ?? '', 'primary'),
  ]);

  // Calendar summary
  const calSummary = formatEventsForTelegram(events, targetDate ?? '');

  // Inbox summary
  const unreadCount = messages.filter(m => m.isUnread).length;
  const inboxLines = messages.map(m => {
    const flag = m.isUnread ? '[unread] ' : '';
    return `${flag}From: ${m.from}\nSubject: ${m.subject}\n${m.snippet.slice(0, 120)}`;
  });

  const output = [
    `=== CALENDAR ===`,
    calSummary,
    ``,
    `=== INBOX (${unreadCount} unread of ${messages.length} shown) ===`,
    ...inboxLines.map((l, i) => `[${i + 1}] ${l}`),
  ].join('\n');

  console.log(output);
}

main().catch(err => {
  console.error('[pamela] error:', err.message);
  process.exit(1);
});
