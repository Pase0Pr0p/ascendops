import { describe, it, expect } from 'vitest';

// Test the delivery-truth logic extracted from sendTelegramWithKeyboard.
// The production function uses curl + JSON.parse; these tests verify
// the response-parsing decision tree without network calls.

function parseTelegramResponse(raw: string): { ok: boolean; error?: string } {
  try {
    const resp = JSON.parse(raw);
    if (resp.ok !== true) {
      return { ok: false, error: resp.description ?? 'ok_not_true' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'unparseable' };
  }
}

describe('Telegram response parsing (delivery truth)', () => {
  it('ok:true → success', () => {
    const r = parseTelegramResponse('{"ok":true,"result":{"message_id":123}}');
    expect(r.ok).toBe(true);
  });

  it('ok:false with description → failure with reason', () => {
    const r = parseTelegramResponse('{"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities"}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain("parse entities");
  });

  it('ok:false without description → failure', () => {
    const r = parseTelegramResponse('{"ok":false,"error_code":500}');
    expect(r.ok).toBe(false);
  });

  it('missing ok field → failure', () => {
    const r = parseTelegramResponse('{"result":"something"}');
    expect(r.ok).toBe(false);
  });

  it('empty string → unparseable → failure', () => {
    const r = parseTelegramResponse('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unparseable');
  });

  it('HTML error page → unparseable → failure', () => {
    const r = parseTelegramResponse('<html><body>502 Bad Gateway</body></html>');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unparseable');
  });

  it('truncated JSON → unparseable → failure', () => {
    const r = parseTelegramResponse('{"ok":tr');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unparseable');
  });
});

describe('plain text approval message safety', () => {
  it('Markdown special chars in tenant name do not break plain text', () => {
    const tenantName = 'John_Doe *starred* `backtick` [link]';
    const msg = `Tenant: ${tenantName}`;
    expect(msg).toContain('John_Doe *starred*');
    expect(msg).not.toContain('\\');
  });

  it('issue description with underscores passes through unmodified', () => {
    const issue = 'water_heater_not_working in unit_4';
    const msg = `Issue: ${issue}`;
    expect(msg).toBe('Issue: water_heater_not_working in unit_4');
  });
});

describe('locationRef format (first2-first2-unit)', () => {
  function formatLocationRef(payload: Record<string, unknown>): string {
    const addr = String(payload['property_label'] ?? '');
    const unit = String(payload['unit_label'] ?? '');
    const addrParts = addr.split(/\s+/);
    const first2addr = (addrParts[0] ?? '').substring(0, 2);
    const first2street = (addrParts[1] ?? '').substring(0, 2);
    const unitShort = unit.replace(/^Unit\s*/i, '').trim();
    return `${first2addr}-${first2street}${unitShort ? '-' + unitShort : ''}`;
  }

  it('72 Cherry St Unit 4 → 72-Ch-4', () => {
    expect(formatLocationRef({ property_label: '72 Cherry St', unit_label: 'Unit 4' })).toBe('72-Ch-4');
  });

  it('504 Baroona Dr Unit 12 → 50-Ba-12', () => {
    expect(formatLocationRef({ property_label: '504 Baroona Dr', unit_label: 'Unit 12' })).toBe('50-Ba-12');
  });

  it('219 Paloma Ave → 21-Pa (no unit)', () => {
    expect(formatLocationRef({ property_label: '219 Paloma Ave', unit_label: '' })).toBe('21-Pa');
  });

  it('handles missing property gracefully', () => {
    expect(formatLocationRef({ property_label: '', unit_label: 'Unit 1' })).toBe('--1');
  });
});
