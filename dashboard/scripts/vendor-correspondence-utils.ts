import { createHash } from 'crypto';

export function normalizeVendorName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function vendorNameTokens(normalized: string): string[] {
  return normalized.split(' ').filter(t => t.length >= 2);
}

export function verifyVendorNameMatch(vendorName: string, label: string): boolean {
  const stripped = label.replace(/\s*\(Vendor\)\s*$/i, '').trim();
  const normVendor = normalizeVendorName(vendorName);
  const normLabel = normalizeVendorName(stripped);
  if (normVendor.length === 0 || normLabel.length === 0) return false;
  if (normVendor === normLabel) return true;

  const commaFlip = (s: string) => {
    const parts = s.split(',').map(p => p.trim());
    return parts.length === 2 ? normalizeVendorName(`${parts[1]} ${parts[0]}`) : null;
  };
  const flippedVendor = commaFlip(vendorName);
  const flippedLabel = commaFlip(stripped);
  if (flippedVendor && flippedVendor === normLabel) return true;
  if (flippedLabel && flippedLabel === normVendor) return true;
  if (flippedVendor && flippedLabel && flippedVendor === flippedLabel) return true;

  const vTokens = vendorNameTokens(normVendor);
  const lTokens = vendorNameTokens(normLabel);
  if (vTokens.length === 0 || lTokens.length === 0) return false;

  const shorter = vTokens.length <= lTokens.length ? vTokens : lTokens;
  const longer = vTokens.length <= lTokens.length ? lTokens : vTokens;

  if (shorter.length === 1) return false;

  return shorter.every(t => longer.includes(t));
}

export function computeEmailApprovalHash(
  srId: string, woId: string, subject: string, message: string,
  vendor: string, toAddress: string, rowLabel: string,
): string {
  const payload = JSON.stringify({
    srId, woId, subject, message, vendor, toAddress, rowLabel, channel: 'email',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function computeCloseWoApprovalHash(
  srId: string, woId: string, completedOn: string,
  remarks: string, noBill: boolean,
): string {
  const payload = JSON.stringify({
    srId, woId, completedOn, remarks, noBill,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function computeStatusTransitionHash(
  srId: string, woId: string, targetStatus: string, currentStatus: string,
): string {
  const payload = JSON.stringify({
    srId, woId, targetStatus, currentStatus, action: 'status_transition',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function computeMessageApprovalHash(
  srId: string, woId: string, message: string, tenant: string,
  channel: string, recipientLabel: string, rowLabel: string,
  formAction: string, formMethod: string, textareaName: string,
  hiddenFieldNames: string, endpointContractHash: string,
): string {
  const payload = JSON.stringify({
    srId, woId, message, tenant, channel, recipientLabel, rowLabel,
    formAction, formMethod, textareaName, hiddenFieldNames, endpointContractHash,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
