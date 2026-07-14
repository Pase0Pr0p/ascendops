/**
 * Gmail REST API client for utility-bills@paseoproperties.com.
 * Reads unread messages, fetches attachments, marks read, sends for AppFolio intake.
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const APPFOLIO_INTAKE_EMAIL = 'paseoproperties@invoices.appfolio.com';

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  bodyText: string;
  attachments: GmailAttachment[];
}

// Decode base64url to string
function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Decode base64url to Buffer (for binary data)
function b64urlDecodeBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Walk MIME parts tree, collect text and attachment metadata
function walkParts(
  parts: Array<{ mimeType: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: unknown[]; filename?: string; headers?: Array<{ name: string; value: string }> }>,
  textAccumulator: string[],
  attachments: GmailAttachment[],
): void {
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      textAccumulator.push(b64urlDecode(part.body.data));
    } else if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size ?? 0,
      });
    } else if (Array.isArray(part.parts)) {
      walkParts(part.parts as typeof parts, textAccumulator, attachments);
    }
  }
}

export async function listUnreadMessages(token: string): Promise<string[]> {
  const url = `${GMAIL_API}/messages?labelIds=INBOX&q=is:unread&maxResults=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail list failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { messages?: Array<{ id: string }> };
  return (body.messages ?? []).map((m) => m.id);
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const res = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail get message ${id} failed (${res.status}): ${await res.text()}`);

  const msg = await res.json() as {
    id: string;
    threadId: string;
    payload: {
      headers: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: unknown[];
    };
  };

  const headers = msg.payload.headers;
  const textAccumulator: string[] = [];
  const attachments: GmailAttachment[] = [];

  if (msg.payload.body?.data) {
    textAccumulator.push(b64urlDecode(msg.payload.body.data));
  }
  if (Array.isArray(msg.payload.parts)) {
    walkParts(msg.payload.parts as Parameters<typeof walkParts>[0], textAccumulator, attachments);
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: extractHeader(headers, 'subject'),
    from: extractHeader(headers, 'from'),
    date: extractHeader(headers, 'date'),
    bodyText: textAccumulator.join('\n'),
    attachments,
  };
}

export async function getAttachmentData(token: string, msgId: string, attachmentId: string): Promise<Buffer> {
  const res = await fetch(`${GMAIL_API}/messages/${msgId}/attachments/${attachmentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail attachment fetch failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { data: string };
  return b64urlDecodeBuffer(body.data);
}

export async function markRead(token: string, id: string): Promise<void> {
  const res = await fetch(`${GMAIL_API}/messages/${id}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
  if (!res.ok) throw new Error(`Gmail markRead ${id} failed (${res.status}): ${await res.text()}`);
}

// Build RFC2822 multipart/mixed message and send via Gmail API
export async function sendToAppFolioIntake(
  token: string,
  pdfBuffer: Buffer,
  pdfFilename: string,
  subject: string,
  bodyText: string,
): Promise<void> {
  const boundary = `boundary_${Date.now()}`;
  const fromAddr = process.env.GOOGLE_UTILITY_BILLS_SUBJECT ?? 'utility-bills@paseoproperties.com';

  const pdfB64 = pdfBuffer.toString('base64');

  const rawMessage = [
    `From: ${fromAddr}`,
    `To: ${APPFOLIO_INTAKE_EMAIL}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    '',
    pdfB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const encoded = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}
