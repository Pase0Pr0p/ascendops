/**
 * Gmail read-only wrapper for Pamela.
 * Requires gmail.readonly DWD scope authorized in Workspace Admin console.
 */

import { mintPamelaToken, GMAIL_SCOPE } from './auth';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  isUnread: boolean;
}

async function gmailFetch(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error (${res.status}) ${path}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractBody(payload: Record<string, unknown>): string {
  // Recursively extract text/plain part
  function walk(part: Record<string, unknown>): string {
    const mimeType = part.mimeType as string ?? '';
    const body = part.body as Record<string, unknown> ?? {};
    if (mimeType === 'text/plain' && body.data) {
      return Buffer.from(body.data as string, 'base64url').toString('utf8');
    }
    const parts = part.parts as Array<Record<string, unknown>> ?? [];
    for (const p of parts) {
      const found = walk(p);
      if (found) return found;
    }
    return '';
  }
  return walk(payload).trim();
}

export async function listInboxMessages(opts: {
  maxResults?: number;
  query?: string;
  unreadOnly?: boolean;
} = {}): Promise<GmailMessage[]> {
  const token = await mintPamelaToken(GMAIL_SCOPE);
  const { maxResults = 20, query = '', unreadOnly = false } = opts;
  const q = [query, unreadOnly ? 'is:unread' : ''].filter(Boolean).join(' ');
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set('q', q);

  const listRes = await gmailFetch(token, `/messages?${params}`) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  const messages = listRes.messages ?? [];
  const results: GmailMessage[] = [];

  for (const { id } of messages) {
    const msg = await gmailFetch(token, `/messages/${id}?format=full`) as {
      id: string;
      threadId: string;
      snippet: string;
      labelIds: string[];
      payload: Record<string, unknown>;
    };

    const headers = msg.payload.headers as Array<{ name: string; value: string }> ?? [];
    results.push({
      id: msg.id,
      threadId: msg.threadId,
      from: extractHeader(headers, 'from'),
      subject: extractHeader(headers, 'subject'),
      date: extractHeader(headers, 'date'),
      snippet: msg.snippet ?? '',
      bodyText: extractBody(msg.payload).slice(0, 2000),
      isUnread: (msg.labelIds ?? []).includes('UNREAD'),
    });
  }

  return results;
}

export async function getInboxSummary(maxMessages = 10): Promise<{
  unread: number;
  messages: GmailMessage[];
}> {
  const [allRecent, unreadOnly] = await Promise.all([
    listInboxMessages({ maxResults: maxMessages, query: 'in:inbox' }),
    listInboxMessages({ maxResults: 1, query: 'in:inbox is:unread' }),
  ]);
  return { unread: unreadOnly.length > 0 ? -1 : 0, messages: allRecent };
  // Note: unread count via label requires a separate labels API call;
  // -1 here means "has unread" — upgrade to exact count if needed.
}
