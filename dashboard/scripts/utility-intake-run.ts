/**
 * Utility bill email-intake runner.
 * Reads unread messages from utility-bills@paseoproperties.com,
 * parses bill fields, deduplicates, inserts to utility_bills, and
 * sends a Telegram approval request to Albie.
 *
 * Approval callback is handled by claudia in-session (fast-checker).
 * On approve: claudia re-fetches the PDF via source_email_id and forwards
 * to paseoproperties@invoices.appfolio.com.
 *
 * STAGED: does NOT touch the live PG&E/Marin portal-scrape path.
 * New acquisition_method=email_intake rows are separate from existing portal_scrape rows.
 *
 * Run via launchd: com.paseo.utility-intake.plist
 */

import { mintGmailToken } from '../src/lib/utility-intake/auth';
import {
  listUnreadMessages,
  getMessage,
  getAttachmentData,
  markRead,
} from '../src/lib/utility-intake/gmail';
import {
  parseBillEmail,
  computeBillHash,
  computePdfHash,
  computeBodyHash,
} from '../src/lib/utility-intake/parse';
import {
  lookupProvider,
  checkDedup,
  insertBill,
} from '../src/lib/utility-intake/db';
import { sendApprovalRequest } from '../src/lib/utility-intake/gate';

function log(msg: string) {
  console.log(`[utility-intake ${new Date().toISOString()}] ${msg}`);
}

async function processMessage(token: string, msgId: string): Promise<void> {
  log(`Processing message ${msgId}`);
  const msg = await getMessage(token, msgId);
  log(`  From: ${msg.from} | Subject: ${msg.subject}`);

  // Parse bill fields from email text
  const parsed = parseBillEmail(msg.subject, msg.bodyText, msg.from);
  log(`  Provider hint: ${parsed.providerHint} | Account: ${parsed.accountNumber} | Period: ${parsed.periodStart} | Complete: ${parsed.parseComplete}`);

  // Resolve provider row in DB
  const provider = await lookupProvider(parsed.providerHint);
  log(`  Provider DB: ${provider?.slug ?? 'not found'}`);

  // Handle PDF attachment — pdf_hash is NOT NULL; fall back to email body hash when no PDF
  const pdfAttachment = msg.attachments.find(
    (a) => a.mimeType === 'application/pdf' || a.filename.endsWith('.pdf'),
  );
  let pdfHash: string;
  let originalFilename: string;
  if (pdfAttachment) {
    log(`  PDF: ${pdfAttachment.filename} (${pdfAttachment.size} bytes)`);
    const pdfBuf = await getAttachmentData(token, msgId, pdfAttachment.attachmentId);
    pdfHash = computePdfHash(pdfBuf);
    originalFilename = pdfAttachment.filename;
    log(`  pdf_hash: ${pdfHash.slice(0, 16)}... (PDF)`);
  } else {
    // No PDF — hash the email body text as the document fingerprint
    pdfHash = computeBodyHash(msg.bodyText);
    originalFilename = `email-${msgId}`;
    log(`  pdf_hash: ${pdfHash.slice(0, 16)}... (body fallback — no PDF attachment)`);
  }

  // Compute bill_hash if we have the three required fields
  let billHash: string | null = null;
  if (provider && parsed.accountNumber && parsed.periodStart) {
    billHash = computeBillHash(provider.slug, parsed.accountNumber, parsed.periodStart);
    log(`  bill_hash: ${billHash.slice(0, 16)}...`);
  }

  // Dedup check — skip if already in utility_bills
  const isDup = await checkDedup(pdfHash, billHash);
  if (isDup) {
    log(`  SKIPPED (duplicate — pdf_hash or bill_hash already in utility_bills)`);
    await markRead(token, msgId);
    return;
  }

  // statement_date is NOT NULL — map period_end ?? period_start (billing period end ≈ statement date)
  const statementDate = parsed.periodEnd ?? parsed.periodStart;

  // Insert bill — flag PENDING_APPROVAL if parse complete, else PARSE_INCOMPLETE
  const flagType = parsed.parseComplete ? 'PENDING_APPROVAL' : 'PARSE_INCOMPLETE';
  const billId = await insertBill({
    provider_id: provider?.id ?? null,
    account_number: parsed.accountNumber,
    pdf_hash: pdfHash,
    bill_hash: billHash,
    statement_date: statementDate,
    original_filename: originalFilename,
    period_start: parsed.periodStart,
    period_end: parsed.periodEnd,
    amount_due: parsed.amountDue,
    delivery_channel: 'email',
    source_email_id: msgId,
    flag_type: flagType,
  });
  log(`  Inserted bill ${billId} (${flagType})`);

  // Send Telegram approval gate to Albie
  const telegramMsgId = await sendApprovalRequest({
    billId,
    providerName: provider?.name ?? parsed.providerHint ?? 'Unknown Provider',
    accountNumber: parsed.accountNumber,
    periodStart: parsed.periodStart,
    amountDue: parsed.amountDue,
    parseComplete: parsed.parseComplete,
  });
  log(`  Telegram approval sent (msg_id: ${telegramMsgId}) for bill ${billId}`);
  void originalFilename; // available to claudia at callback time by re-fetching via source_email_id

  // Mark email read
  await markRead(token, msgId);
  log(`  Marked read`);
}

async function main() {
  log('Starting utility-intake run');

  const token = await mintGmailToken();
  log('Gmail token minted');

  const msgIds = await listUnreadMessages(token);
  log(`Found ${msgIds.length} unread message(s)`);

  if (msgIds.length === 0) {
    log('Nothing to process. Exiting.');
    return;
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const msgId of msgIds) {
    try {
      await processMessage(token, msgId);
      processed++;
    } catch (err) {
      log(`  ERROR processing ${msgId}: ${String(err)}`);
      errors++;
    }
  }

  log(`Done. processed=${processed} skipped=${skipped} errors=${errors}`);
}

main().catch((err) => {
  console.error('[utility-intake] fatal:', err);
  process.exit(1);
});
