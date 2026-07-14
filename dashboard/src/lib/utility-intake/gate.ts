/**
 * Telegram approval gate for utility bill intake.
 * Sends an inline-keyboard message to Albie for approve/reject.
 * Callback data: "ub_approve:<bill_uuid>" / "ub_reject:<bill_uuid>"
 *
 * Response is handled by claudia in-session when fast-checker delivers the callback.
 *
 * Required env vars:
 *   BOT_TOKEN              — claudia's Telegram bot token
 *   ALBIE_TELEGRAM_CHAT_ID — Albie's Telegram chat ID (6398997982)
 */

const TELEGRAM_API = 'https://api.telegram.org';

export interface BillGateParams {
  billId: string;
  providerName: string;
  accountNumber: string | null;
  periodStart: string | null;
  amountDue: number | null;     // dollar decimal
  parseComplete: boolean;
}

function formatAmount(dollars: number | null): string {
  if (dollars == null) return 'unknown';
  return `$${dollars.toFixed(2)}`;
}

export async function sendApprovalRequest(params: BillGateParams): Promise<number> {
  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.ALBIE_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error('BOT_TOKEN and ALBIE_TELEGRAM_CHAT_ID must be set');
  }

  const statusLine = params.parseComplete
    ? ''
    : '\n*PARSE INCOMPLETE* — one or more fields could not be extracted from email body. Review before approving.';

  const text = [
    `*Utility Bill Received*${statusLine}`,
    `Provider: ${params.providerName}`,
    `Account: ${params.accountNumber ?? 'not detected'}`,
    `Period: ${params.periodStart ?? 'not detected'}`,
    `Amount due: ${formatAmount(params.amountDue)}`,
    `Bill ID: \`${params.billId}\``,
    '',
    'Approve to forward to AppFolio Smart Bill intake.',
  ].join('\n');

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `ub_approve:${params.billId}` },
        { text: '❌ Reject', callback_data: `ub_reject:${params.billId}` },
      ]],
    },
  };

  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Telegram sendMessage failed (${res.status}): ${await res.text()}`);

  const result = await res.json() as { ok: boolean; result?: { message_id: number } };
  if (!result.ok || !result.result?.message_id) {
    throw new Error(`Telegram returned ok=false or missing message_id: ${JSON.stringify(result)}`);
  }
  return result.result.message_id;
}

// Answer a callback query (removes the spinner on the button after claudia handles it)
export async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) throw new Error('BOT_TOKEN must be set');
  await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}
