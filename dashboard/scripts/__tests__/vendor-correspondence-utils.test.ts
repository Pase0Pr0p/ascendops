import { describe, it, expect } from 'vitest';
import {
  normalizeVendorName,
  vendorNameTokens,
  verifyVendorNameMatch,
  computeEmailApprovalHash,
  computeMessageApprovalHash,
  computeCloseWoApprovalHash,
} from '../vendor-correspondence-utils.js';

describe('normalizeVendorName', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeVendorName('North Bay Removal')).toBe('north bay removal');
    expect(normalizeVendorName('A.B.C. Plumbing, Inc.')).toBe('abc plumbing inc');
  });

  it('preserves digits', () => {
    expect(normalizeVendorName('24/7 Rooter Service')).toBe('247 rooter service');
  });

  it('collapses whitespace', () => {
    expect(normalizeVendorName('  North   Bay   ')).toBe('north bay');
  });

  it('returns empty for empty input', () => {
    expect(normalizeVendorName('')).toBe('');
    expect(normalizeVendorName('   ')).toBe('');
  });
});

describe('vendorNameTokens', () => {
  it('splits normalized name into tokens >= 2 chars', () => {
    expect(vendorNameTokens('north bay removal')).toEqual(['north', 'bay', 'removal']);
  });

  it('filters single-char tokens', () => {
    expect(vendorNameTokens('a b cd ef')).toEqual(['cd', 'ef']);
  });

  it('returns empty for empty input', () => {
    expect(vendorNameTokens('')).toEqual([]);
  });
});

describe('verifyVendorNameMatch', () => {
  describe('exact matches', () => {
    it('matches identical names', () => {
      expect(verifyVendorNameMatch('North Bay Removal', 'North Bay Removal (Vendor)')).toBe(true);
    });

    it('matches case-insensitive', () => {
      expect(verifyVendorNameMatch('north bay removal', 'North Bay Removal (Vendor)')).toBe(true);
    });

    it('matches with punctuation differences', () => {
      expect(verifyVendorNameMatch('A.B.C. Plumbing', 'ABC Plumbing (Vendor)')).toBe(true);
    });
  });

  describe('comma reorder (pseudo-person names)', () => {
    it('matches "Murray, Patrick" vs "Patrick Murray (Vendor)"', () => {
      expect(verifyVendorNameMatch('Murray, Patrick', 'Patrick Murray (Vendor)')).toBe(true);
    });

    it('matches "Patrick Murray" vs "Murray, Patrick (Vendor)"', () => {
      expect(verifyVendorNameMatch('Patrick Murray', 'Murray, Patrick (Vendor)')).toBe(true);
    });

    it('matches both comma-reordered', () => {
      expect(verifyVendorNameMatch('Murray, Patrick', 'Murray, Patrick (Vendor)')).toBe(true);
    });
  });

  describe('token-bound matching (multi-token)', () => {
    it('matches when vendor name is a subset of row label tokens', () => {
      expect(verifyVendorNameMatch('North Bay Removal', 'North Bay Removal Services (Vendor)')).toBe(true);
    });

    it('matches when row label is a subset of vendor name tokens', () => {
      expect(verifyVendorNameMatch('North Bay Removal Services', 'North Bay Removal (Vendor)')).toBe(true);
    });
  });

  describe('single-token rejection (Cody blocker cases)', () => {
    it('rejects "Pro" matching "All Pro Rooter (Vendor)"', () => {
      expect(verifyVendorNameMatch('Pro', 'All Pro Rooter (Vendor)')).toBe(false);
    });

    it('rejects "ABC" matching "ABC Plumbing (Vendor)"', () => {
      expect(verifyVendorNameMatch('ABC', 'ABC Plumbing (Vendor)')).toBe(false);
    });

    it('rejects "Bay" matching "North Bay Removal (Vendor)"', () => {
      expect(verifyVendorNameMatch('Bay', 'North Bay Removal (Vendor)')).toBe(false);
    });
  });

  describe('empty/invalid inputs', () => {
    it('rejects empty vendor name', () => {
      expect(verifyVendorNameMatch('', 'North Bay Removal (Vendor)')).toBe(false);
    });

    it('rejects empty label', () => {
      expect(verifyVendorNameMatch('North Bay Removal', '')).toBe(false);
    });

    it('rejects both empty', () => {
      expect(verifyVendorNameMatch('', '')).toBe(false);
    });

    it('rejects whitespace-only vendor name', () => {
      expect(verifyVendorNameMatch('   ', 'North Bay Removal (Vendor)')).toBe(false);
    });
  });

  describe('no false positives across unrelated names', () => {
    it('rejects completely different vendor', () => {
      expect(verifyVendorNameMatch('Ace Plumbing', 'North Bay Removal (Vendor)')).toBe(false);
    });

    it('rejects partial word overlap', () => {
      expect(verifyVendorNameMatch('Bay Area Electric', 'North Bay Removal (Vendor)')).toBe(false);
    });
  });

  describe('label suffix handling', () => {
    it('strips (Vendor) suffix case-insensitive', () => {
      expect(verifyVendorNameMatch('North Bay Removal', 'North Bay Removal (vendor)')).toBe(true);
      expect(verifyVendorNameMatch('North Bay Removal', 'North Bay Removal (VENDOR)')).toBe(true);
    });

    it('works without (Vendor) suffix', () => {
      expect(verifyVendorNameMatch('North Bay Removal', 'North Bay Removal')).toBe(true);
    });
  });
});

describe('computeEmailApprovalHash', () => {
  const baseArgs = {
    srId: '8046', woId: '8286', subject: 'Follow-up on WO#8010',
    message: 'Please confirm your availability.', vendor: 'North Bay Removal',
    toAddress: 'northbayremoval@gmail.com', rowLabel: 'North Bay Removal (Vendor)',
  };

  it('returns a 16-char hex string', () => {
    const hash = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).toBe(h2);
  });

  it('changes when subject changes', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, 'Different subject', baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when message changes', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, 'Different message',
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when toAddress changes', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, 'other@email.com', baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when vendor changes', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      'Different Vendor', baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when WO IDs change', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      '9999', '9999', baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when rowLabel changes', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, 'Different Label (Vendor)',
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when srId changes independently of woId', () => {
    const h1 = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    const h2 = computeEmailApprovalHash(
      '9999', baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    expect(h1).not.toBe(h2);
  });

  it('binds channel=email in payload', () => {
    const emailHash = computeEmailApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.subject, baseArgs.message,
      baseArgs.vendor, baseArgs.toAddress, baseArgs.rowLabel,
    );
    // SMS hash with same fields should differ because channel is different
    const smsPayload = JSON.stringify({
      srId: baseArgs.srId, woId: baseArgs.woId, subject: baseArgs.subject,
      message: baseArgs.message, vendor: baseArgs.vendor,
      toAddress: baseArgs.toAddress, rowLabel: baseArgs.rowLabel, channel: 'sms',
    });
    const { createHash } = require('crypto');
    const smsHash = createHash('sha256').update(smsPayload).digest('hex').slice(0, 16);
    expect(emailHash).not.toBe(smsHash);
  });
});

describe('computeMessageApprovalHash', () => {
  const baseArgs = {
    srId: '8046', woId: '8286', message: 'Hello',
    tenant: 'Albert L. Coles III', channel: 'sms',
    recipientLabel: 'Albert L. Coles III', rowLabel: 'Albert L. Coles III (Resident)',
    formAction: 'no_form', formMethod: 'POST', textareaName: 'body',
    hiddenFieldNames: '', endpointContractHash: 'abc123',
  };

  it('returns a 16-char hex string', () => {
    const hash = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).toBe(h2);
  });

  it('changes when message changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, 'Different message', baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when channel changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      'sms', baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      'email', baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when tenant changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, 'Different Tenant',
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when recipientLabel changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, 'Different Label', baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when rowLabel changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, 'Different Row (Resident)',
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when formAction changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      '/different/action', baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when endpointContractHash changes', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, 'xyz789',
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when WO IDs change', () => {
    const h1 = computeMessageApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    const h2 = computeMessageApprovalHash(
      '9999', '9999', baseArgs.message, baseArgs.tenant,
      baseArgs.channel, baseArgs.recipientLabel, baseArgs.rowLabel,
      baseArgs.formAction, baseArgs.formMethod, baseArgs.textareaName,
      baseArgs.hiddenFieldNames, baseArgs.endpointContractHash,
    );
    expect(h1).not.toBe(h2);
  });
});

describe('computeCloseWoApprovalHash', () => {
  const baseArgs = {
    srId: '8046', woId: '8286', completedOn: '07/19/2026',
    remarks: 'Work verified complete', noBill: false,
  };

  it('returns a 16-char hex string', () => {
    const hash = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is deterministic', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(h1).toBe(h2);
  });

  it('changes when completedOn changes', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, '01/01/2026',
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when remarks change', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      'Different remarks', baseArgs.noBill,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when noBill toggles', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, false,
    );
    const h2 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, true,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when WO IDs change', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      '9999', '9999', baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(h1).not.toBe(h2);
  });

  it('changes when srId changes independently of woId', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      '9999', baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(h1).not.toBe(h2);
  });

  it('empty remarks produces different hash from non-empty', () => {
    const h1 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      '', baseArgs.noBill,
    );
    const h2 = computeCloseWoApprovalHash(
      baseArgs.srId, baseArgs.woId, baseArgs.completedOn,
      baseArgs.remarks, baseArgs.noBill,
    );
    expect(h1).not.toBe(h2);
  });
});

describe('post-send type filter contract', () => {
  const mixedThread = [
    { direction: 'outbound' as const, type: 'sms' as const, text: 'Old SMS message' },
    { direction: 'inbound' as const, type: 'sms' as const, text: 'Tenant reply' },
    { direction: 'outbound' as const, type: 'sms' as const, text: 'Second SMS outbound' },
    { direction: 'outbound' as const, type: 'email' as const, text: 'Subject lineEmail body content here' },
  ];

  it('SMS filter excludes email outbounds', () => {
    const smsOutbounds = mixedThread.filter(m => m.direction === 'outbound' && m.type === 'sms');
    expect(smsOutbounds).toHaveLength(2);
    expect(smsOutbounds.every(m => m.type === 'sms')).toBe(true);
    const latest = smsOutbounds[smsOutbounds.length - 1];
    expect(latest.text).toBe('Second SMS outbound');
  });

  it('email filter excludes SMS outbounds', () => {
    const emailOutbounds = mixedThread.filter(m => m.direction === 'outbound' && m.type === 'email');
    expect(emailOutbounds).toHaveLength(1);
    expect(emailOutbounds[0].type).toBe('email');
    expect(emailOutbounds[0].text).toContain('Email body');
  });

  it('email as newest outbound does NOT satisfy SMS verify', () => {
    const allOutbounds = mixedThread.filter(m => m.direction === 'outbound');
    const latestAny = allOutbounds[allOutbounds.length - 1];
    expect(latestAny.type).toBe('email');

    const smsOutbounds = mixedThread.filter(m => m.direction === 'outbound' && m.type === 'sms');
    const latestSms = smsOutbounds[smsOutbounds.length - 1];
    expect(latestSms.type).toBe('sms');
    expect(latestSms.text).not.toContain('Email body');
  });

  it('SMS as newest outbound does NOT satisfy email verify', () => {
    const smsLastThread = [
      { direction: 'outbound' as const, type: 'email' as const, text: 'Old email' },
      { direction: 'outbound' as const, type: 'sms' as const, text: 'New SMS after email' },
    ];
    const emailOutbounds = smsLastThread.filter(m => m.direction === 'outbound' && m.type === 'email');
    const latestEmail = emailOutbounds[emailOutbounds.length - 1];
    expect(latestEmail.text).toBe('Old email');
    expect(latestEmail.text).not.toContain('New SMS');
  });
});
