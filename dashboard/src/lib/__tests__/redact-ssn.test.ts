/**
 * Drift-guard for the dashboard display-mirror SSN scrubber.
 *
 * The dashboard cannot import the canonical redactSSN at RUNTIME (Turbopack
 * root is pinned to the dashboard dir). But vitest runs with `--root ..` (the
 * monorepo root), so this TEST imports the canonical module directly and uses
 * it as the ORACLE: for every shared-corpus input plus the R1/R2 chunk-split
 * residual cases and an ANSI-stripped form, the mirror MUST equal
 * redactSSN(x, { aggressive: true }). If the local copy drifts from canonical,
 * this test goes red — the same lockstep mechanism that pins the JS matcher to
 * the Python scrub_ssn.
 */
import { describe, it, expect } from 'vitest';
import { redactSSNForDisplay, stripLogControlSequences, redactSVGText } from '../redact-ssn';
// Canonical oracle + shared corpus, resolved from the monorepo test root.
import { redactSSN } from '../../../../src/utils/ssn-redaction';
import corpus from '../../../../tests/fixtures/ssn-corpus.json';

const oracle = (x: string) => redactSSN(x, { aggressive: true });

describe('redactSSNForDisplay — drift-guarded against canonical aggressive', () => {
  // PII v2 m2: the labeled-bank-acct cases are NO LONGER skipped. The display
  // mirror now implements the same label-gated bank-acct pass canonical's
  // aggressive oracle runs (makeBankAcctConservativeMatcher does NOT short-circuit
  // on aggressive — bank-acct is label-required in ALL modes). So a labeled bank
  // run redacts identically: a non-9-length labeled run → [REDACTED-BANK-ACCT],
  // a 9-digit labeled run → [REDACTED-SSN] (aggressive bare-9 consumes it first,
  // same as the oracle). EVERY corpus case is now part of this drift guard.
  const cases = (corpus as {
    cases: Array<{ name: string; input: string }>;
  }).cases;

  for (const c of cases) {
    it(`matches canonical aggressive on corpus case: ${c.name}`, () => {
      expect(redactSSNForDisplay(c.input)).toBe(oracle(c.input));
    });
  }

  // Extra inputs beyond the corpus: the R1/R2 chunk-split residuals (the whole
  // reason aggressive mode is used here), partial/dotted forms, the ANSI-
  // stripped interleave, phones (must NOT redact), and bare 9-digit IDs (DO
  // redact under aggressive). Each is checked against the canonical oracle.
  const extra: Array<[string, string]> = [
    ['R1 label-adjacent', 'SSN: 987654321'],
    ['R2 far label (>40ch)', 'social security number recorded earlier in the file for tenant 987654321'],
    ['bare-9 no label (aggressive redacts)', 'id 987654321 end'],
    ['ANSI-stripped interleave', '987654321'],
    ['formatted dash', '123-45-6789'],
    ['formatted dotted', '123.45.6789'],
    ['phone 10-digit (no redact)', 'call 423-555-0142 now'],
    ['two SSNs one line', 'a 111-22-3333 b 987654321 c'],
    ['plain text no ssn', 'the quick brown fox 1234'],
    ['already-redacted placeholder (idempotent)', 'paid [REDACTED-SSN] today'],
    ['8-digit (not an SSN)', 'ref 12345678 ok'],
    ['10-digit run (not bare-9)', 'num 1234567890 ok'],
  ];

  for (const [name, input] of extra) {
    it(`matches canonical aggressive: ${name}`, () => {
      expect(redactSSNForDisplay(input)).toBe(oracle(input));
    });
  }

  it('is idempotent (redact(redact(x)) === redact(x))', () => {
    const samples = ['SSN: 987654321', '123-45-6789', 'id 987654321 plain'];
    for (const s of samples) {
      expect(redactSSNForDisplay(redactSSNForDisplay(s))).toBe(redactSSNForDisplay(s));
    }
  });
});

// The log route applies stripLogControlSequences -> slice -> redactSSNForDisplay.
// These pin the load-bearing ORDER: stripping ANSI/control BEFORE the scrub, so
// an escape interleaved in a digit run cannot let a bare-9 SSN evade redaction.
// (An end-to-end route-import test is not runnable in the monorepo vitest — the
// route transitively loads the native better-sqlite3 dep, absent from the root
// node_modules — so the guarantee is pinned here on the pure pipeline the route
// composes, which IS locally verifiable.)
describe('stripLogControlSequences — runs before the scrub', () => {
  it('removes an ANSI escape interleaved in a digit run', () => {
    expect(stripLogControlSequences('987\x1b[0m654321')).toBe('987654321');
  });

  it('strips OSC sequences and C0 control chars but keeps newlines/tabs', () => {
    expect(stripLogControlSequences('a\x1b]0;title\x07b\x00c\td')).toBe('abc\td');
    expect(stripLogControlSequences('line1\nline2')).toBe('line1\nline2');
  });

  it('strip-then-scrub catches an ANSI-interleaved SSN that pre-strip scrub would miss', () => {
    const raw = 'tenant 987\x1b[0m654321 on file';
    // Pre-strip scrub would see the escape splitting the run and miss it:
    expect(redactSSNForDisplay(raw)).toContain('987'); // NOT redacted on raw bytes
    // Correct order (what the route does): strip first, then scrub.
    const out = redactSSNForDisplay(stripLogControlSequences(raw));
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).not.toContain('987654321');
  });

  it('strip-then-scrub redacts a far-label (R2) SSN and leaves a phone intact', () => {
    const raw =
      'social security number recorded earlier, value 987654321; call 423-555-0142';
    const out = redactSSNForDisplay(stripLogControlSequences(raw));
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).not.toContain('987654321');
    expect(out).toContain('423-555-0142'); // phone is not an SSN
  });

  // Strip-completeness: an SSN split by ANY invisible control/format char must
  // collapse on strip so the scrub fires. The oracle test pins scrubber-
  // equivalence to canonical but NOT strip-completeness, so these are the guard
  // for that class (finding #19). Each interleaves a different evasion char in
  // 987654321 and asserts the strip+scrub redacts it.
  const evasions: Array<[string, string]> = [
    ['DEL 0x7f', '987\x7f654321'],
    ['C1 0x80', '987\x80654321'],
    ['C1 CSI 0x9b', '987\x9b654321'],
    ['C1 0x9f', '987\x9f654321'],
    ['ZWSP U+200B', '987\u200b654321'],
    ['ZWNJ U+200C', '987\u200c654321'],
    ['ZWJ U+200D', '987\u200d654321'],
    ['LRM U+200E', '987\u200e654321'],
    ['word joiner U+2060', '987\u2060654321'],
    ['soft hyphen U+00AD', '987\u00ad654321'],
    ['BOM/ZWNBSP U+FEFF', '987\ufeff654321'],
    ['RLO U+202E', '987\u202e654321'],
    ['FSI U+2068', '987\u2068654321'],
    // Reviewer A's enumeration-gap chars, now closed wholesale by the property
    // class \p{Cf} + \p{Default_Ignorable_Code_Point}:
    ['invisible-times U+2062', '987\u2062654321'],
    ['invisible-sep U+2063', '987\u2063654321'],
    ['ALM U+061C', '987\u061c654321'],
    ['variation-selector U+FE0F', '987\ufe0f654321'],
    ['CGJ U+034F', '987\u034f654321'],
  ];
  for (const [name, raw] of evasions) {
    it(`strip-then-scrub redacts an SSN split by ${name}`, () => {
      const out = redactSSNForDisplay(stripLogControlSequences(raw));
      expect(out).toBe('[REDACTED-SSN]');
      expect(out).not.toContain('654321');
    });
  }

  it('strip removes DEL/C1/zero-width but preserves ordinary text, tabs, newlines', () => {
    expect(stripLogControlSequences('a\x7fb\x9bc\u200bd\ufeffe')).toBe('abcde');
    expect(stripLogControlSequences('col1\tcol2\nrow')).toBe('col1\tcol2\nrow');
  });

  it('strip PRESERVES visible combining diacritics (not \\p{Mn}) \u2014 no caf\u00e9\u2192cafe FP', () => {
    // U+0301 COMBINING ACUTE is \p{Mn} but NOT \p{Default_Ignorable}: it is a
    // VISIBLE diacritic and must survive. Stripping \p{Mn} would mangle names.
    expect(stripLogControlSequences('cafe\u0301 sen\u0303or')).toBe('cafe\u0301 sen\u0303or');
  });

  it('redactSSNForDisplay redacts a Unicode-space-separated SSN (Zs-widen mirror)', () => {
    expect(redactSSNForDisplay('123\u00a045\u00a06789')).toBe('[REDACTED-SSN]');
    expect(redactSSNForDisplay('id 123\u200745\u20076789 x')).toContain('[REDACTED-SSN]');
    // non-3-2-4 figure-space-aligned run survives (not an SSN shape)
    expect(redactSSNForDisplay('12345\u200767890')).toBe('12345\u200767890');
  });
});

describe('redactSVGText \u2014 SVG text-node-only scrub (closes the SVG inline residual)', () => {
  it('redacts an SSN in <text> element content', () => {
    const svg = '<svg><text x="10" y="20">SSN 123-45-6789</text></svg>';
    const out = redactSVGText(svg);
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).not.toContain('123-45-6789');
  });

  it('redacts an SSN in <tspan> content', () => {
    const svg = '<svg><text><tspan>987654321</tspan></text></svg>';
    const out = redactSVGText(svg);
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).not.toContain('987654321');
  });

  it('NEVER touches geometry/attributes \u2014 9-digit coords, ids, viewBox, path d= survive', () => {
    const svg =
      '<svg viewBox="0 0 123456789 100"><path d="M123456789 0 L987654321 50" id="123456789"/><rect x="987654321"/></svg>';
    // No text nodes with an SSN \u2192 output is byte-identical (attributes untouched).
    expect(redactSVGText(svg)).toBe(svg);
  });

  it('redacts text content but leaves a sibling 9-digit coordinate attribute intact', () => {
    const svg = '<svg><rect x="123456789"/><text>123-45-6789</text></svg>';
    const out = redactSVGText(svg);
    expect(out).toContain('x="123456789"'); // geometry attribute preserved
    expect(out).not.toContain('123-45-6789'); // visible text redacted
    expect(out).toContain('[REDACTED-SSN]');
  });

  it('passes empty input through unchanged', () => {
    expect(redactSVGText('')).toBe('');
  });
});

describe('redactSVGText — all rendered-text encodings (CDATA + entity refs)', () => {
  // The SVG renders the SAME SSN to the human under several encodings; each must
  // redact. (Codex P2 + Aussie sibling on PR #142 follow-up.)
  it('redacts an SSN inside a CDATA section', () => {
    const out = redactSVGText('<svg><text><![CDATA[SSN 123-45-6789]]></text></svg>');
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).toContain('<![CDATA['); // CDATA wrapper preserved
  });

  it('redacts a bare-9 SSN inside a CDATA section', () => {
    const out = redactSVGText('<svg><text><![CDATA[id 987654321]]></text></svg>');
    expect(out).not.toContain('987654321');
    expect(out).toContain('[REDACTED-SSN]');
  });

  it('redacts a decimal-entity-encoded SSN (&#49;&#50;&#51;-45-6789 renders 123-45-6789)', () => {
    const out = redactSVGText('<svg><text>&#49;&#50;&#51;-45-6789</text></svg>');
    expect(out).toContain('[REDACTED-SSN]');
    // rendered form has no SSN
    const rendered = out.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d));
    expect(rendered).not.toMatch(/123-45-6789/);
  });

  it('redacts a hex-entity-encoded SSN, lowercase and uppercase x', () => {
    for (const svg of [
      '<svg><text>&#x31;&#x32;&#x33;-45-6789</text></svg>',
      '<svg><text>&#X31;&#X32;&#X33;-45-6789</text></svg>',
    ]) {
      expect(redactSVGText(svg)).toContain('[REDACTED-SSN]');
    }
  });

  it('redacts a leading-zero entity SSN', () => {
    expect(redactSVGText('<svg><text>&#049;&#050;&#051;-45-6789</text></svg>')).toContain('[REDACTED-SSN]');
  });

  it('care-point (e): a no-SSN text node with legit named entities stays BYTE-IDENTICAL (never un-escaped)', () => {
    const svg = '<svg><text>Smith &amp; Co, see &lt;notes&gt; &quot;ok&quot;</text></svg>';
    expect(redactSVGText(svg)).toBe(svg);
  });

  it('a no-SSN text node with a legit numeric entity stays BYTE-IDENTICAL', () => {
    const svg = '<svg><text>grade &#65;+ &amp; pass</text></svg>';
    expect(redactSVGText(svg)).toBe(svg);
  });

  it('MIXED node (SSN + legit &amp;) re-escapes valid XML with NO double-escape', () => {
    const out = redactSVGText('<svg><text>A&amp;B 123-45-6789</text></svg>');
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).toContain('A&amp;B'); // single-escaped, preserved
    expect(out).not.toContain('&amp;amp;'); // no double-escape
  });

  it('MIXED node (SSN + numeric &#38;) emits valid single-escaped XML (no raw &)', () => {
    const out = redactSVGText('<svg><text>X&#38;Y 123-45-6789</text></svg>');
    expect(out).toContain('[REDACTED-SSN]');
    expect(out).toContain('X&amp;Y'); // numeric-amp normalized to a valid named entity
    expect(out).not.toContain('&amp;amp;');
  });
});
