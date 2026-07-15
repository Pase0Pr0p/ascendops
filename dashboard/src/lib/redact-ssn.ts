/**
 * SSN redaction for the dashboard log-read surface — DISPLAY mirror.
 *
 * CANONICAL SOURCE OF TRUTH: `src/utils/ssn-redaction.ts` `redactSSN`. PII v2
 * milestone-1: canonical is now a LIVE PII-pattern registry (`redactSSN`
 * iterates `PII_REGISTRY`; SSN is its first entry). This dashboard scrubber is a
 * deliberately LIGHTER behavior-parity mirror (no registry class in m1) — its
 * behavior must stay byte-identical to canonical-aggressive, drift-guarded by
 * the oracle test. This is
 * a deliberate, minimal RUNTIME mirror: the dashboard cannot import the
 * canonical module at runtime because `dashboard/next.config.ts` pins the
 * Turbopack workspace root to the dashboard dir (importing parent `src/` would
 * pull the `orgs/` runtime tree into the build and abort on its venv symlinks).
 *
 * DRIFT IS GUARDED BY TEST, NOT BY TRUST. `dashboard/src/lib/__tests__/redact-ssn.test.ts`
 * imports the canonical `redactSSN` (vitest runs with `--root ..`, the monorepo
 * root, so the TEST crosses the boundary the runtime cannot) and asserts
 * `redactSSNForDisplay(x) === redactSSN(x, { aggressive: true })` for every
 * shared-corpus input plus the R1/R2 chunk-split residual cases. Any drift from
 * canonical-aggressive fails that test — the same lockstep mechanism that pins
 * the JS matcher to the Python `scrub_ssn`. If you change the patterns below,
 * the canonical change must land first and this mirror tracks it.
 *
 * MODE = AGGRESSIVE (bare-9-anywhere) on purpose. The PTY Layer-1 holdback
 * leaves two documented residuals in `stdout.log`: R1 (label adjacent to the
 * number, caught conservatively) and R2 (label >40 chars from the number, past
 * the matcher lookback — only aggressive catches it). The dashboard log API is
 * the one path that surfaces `stdout.log` OFF-HOST, so it must close R2 too.
 * Over-redacting a rare unrelated 9-digit ID in a log VIEWER is an acceptable
 * display tradeoff; it is NOT acceptable on connector-egress paths, which is
 * why aggressive mode lives here and not in the conservative write-path scrubs.
 */

const SSN_PLACEHOLDER = '[REDACTED-SSN]';
// PII v2 m2: two NEW adds on this always-aggressive display mirror —
//   (1) formatted-EIN Pass 2 (`XX-XXXXXXX` → [REDACTED-EIN]);
//   (2) a LABEL-GATED bank-account pass (Pass 4) that mirrors canonical's
//       makeBankAcctConservativeMatcher with shortCircuitOnAggressive=FALSE:
//       a labeled 4–17 digit run redacts to [REDACTED-BANK-ACCT] even in
//       aggressive mode, because canonical's bank callback is label-required in
//       ALL modes (aggressive does NOT bypass the label test). Without this the
//       mirror under-redacted `bank account 123456789012` (returned the raw 12
//       digits while canonical redacts) — a LEAK on the dashboard logs route AND
//       the media `.md` route. EIN/routing bare-9 still stay [REDACTED-SSN] via
//       the existing aggressive bare-9 pass (display surface: the precise type
//       label matters less than the redaction). Parity with canonical-aggressive
//       holds: redactSSN(x,{aggressive:true}) produces the same.
const EIN_PLACEHOLDER = '[REDACTED-EIN]';
const BANK_ACCT_PLACEHOLDER = '[REDACTED-BANK-ACCT]';

// Formatted-SSN separator — MIRRORS SSN_SEP in src/utils/ssn-redaction.ts:
// ASCII dash/dot/tab/space + Unicode Zs horizontal spaces (NBSP/figure/narrow/
// thin/etc.), line/para separators excluded. Kept identical so the oracle test
// (redactSSNForDisplay === redactSSN aggressive) stays green on the corpus's
// Unicode-space cases. \d stays ASCII (US SSNs are ASCII digits).
const SSN_SEP = '[-.\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]';

// Invisible/format chars tolerated BETWEEN an SSN's digits — MIRRORS INVIS in
// src/utils/ssn-redaction.ts. Handled IN-PATTERN (matched + redacted with the
// span), NOT stripped, so the oracle (redactSSNForDisplay === redactSSN
// aggressive) stays green on the byte-identity corpus rows (ZWJ-emoji/Indic
// survive). Requires the `u` flag.
const INVIS = '[\\p{Cf}\\p{Default_Ignorable_Code_Point}]*';
/** `n` ASCII digits with optional invisibles interleaved between them. */
function ssnDigits(n: number): string {
  return '\\d' + `(?:${INVIS}\\d)`.repeat(n - 1);
}

// ---------------------------------------------------------------------------
// PII v2 m2 — labeled bank-account display mirror. Every constant below MIRRORS
// src/utils/ssn-redaction.ts EXACTLY so redactSSNForDisplay(x) ===
// redactSSN(x,{aggressive:true}) on labeled bank-acct (the oracle proves it):
//   - LABEL_SEP   — the JS∪python `\s` ∪ underscore class (label-word separator)
//   - BANK_LABEL_ALT (letter-boundary-anchored) — `bank account` / `account number` / `bank acct`
//   - SSN_LABEL_GAP=16 / SSN_LABEL_LOOKBACK=40 — label↔number window
//   - bankAcctRangeRegex — a 4–17 digit candidate (digit-only lookarounds)
// The Pass-4 callback below replicates makeBankAcctConservativeMatcher's body
// (astral→BMP collapse, codepoint-accurate slicing, placeholder-neutralize) with
// shortCircuitOnAggressive=FALSE, so a labeled run redacts and an UNLABELED 4–17
// digit run is left untouched (no FP). Bank-acct sits AFTER the SSN bare-9 pass
// (Pass 1): a labeled 9-digit run is consumed as [REDACTED-SSN] by aggressive
// SSN first (matching the oracle), and only non-9-length labeled runs (8, 10–17)
// reach this pass — exactly canonical's registry order (SSN > … > bank-acct).
const LABEL_SEP =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u002d\\u005f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028-\\u2029\\u202f\\u205f\\u3000\\ufeff]';
const BANK_LABEL_ALT =
  `(?:bank${LABEL_SEP}+account|account${LABEL_SEP}+number|bank${LABEL_SEP}+acct)`;
// LETTER-CLASS boundaries `(?<![a-z])…(?![a-z])` (not `\b`) — mirrors canonical so
// the snake_case key `bank_account_number` redacts (the `account_number` form fires
// across the `_`) and `embankment` (letter-glued) stays excluded. Fixed-width
// lookbehind builds clean in the dashboard bundle (same as SSN's `(?<![0-9])`).
const BANK_LABEL_BEFORE = new RegExp(`(?<![a-z])${BANK_LABEL_ALT}(?![a-z])[\\s\\S]{0,16}$`, 'i');
const BANK_LABEL_AFTER = new RegExp(`^[\\s\\S]{0,16}(?<![a-z])${BANK_LABEL_ALT}(?![a-z])`, 'i');
const SSN_LABEL_LOOKBACK = 40; // longest label + gap(16) + margin — mirrors canonical

/** Bank-account candidate: a 4–17 digit run, invisibles tolerated between digits,
 *  digit-only lookarounds. Mirrors bankAcctRangeRegex in canonical. Fresh per call. */
function bankAcctRangeRegex(): RegExp {
  return new RegExp(`(?<![0-9])\\d(?:${INVIS}\\d){3,16}(?![0-9])`, 'gu');
}

/**
 * Label-gated bank-account redaction — Pass 4 of the display mirror. Mirrors
 * canonical makeBankAcctConservativeMatcher(BANK_*, shortCircuitOnAggressive=false):
 * a 4–17 digit candidate redacts to [REDACTED-BANK-ACCT] ONLY when a bank label
 * is within the 40-char codepoint window on either side; an unlabeled run is left
 * byte-identical. Astral codepoints in the window are collapsed to one BMP char
 * so `[\s\S]{0,16}` counts codepoints (no `/u` case-fold drift), and any existing
 * placeholder is neutralized so its literal text can't act as a label. Runs AFTER
 * the SSN/EIN passes so their placeholders are already bracketed (the digit regex
 * can't re-match them).
 */
function redactBankAcctForDisplay(text: string): string {
  const neutral = ' '.repeat(BANK_ACCT_PLACEHOLDER.length);
  const collapse = (cps: string[]): string =>
    cps.map((cp) => (cp.length > 1 ? '�' : cp)).join('');
  return text.replace(bankAcctRangeRegex(), (match: string, offset: number, full: string): string => {
    const beforeCps = Array.from(full.slice(0, offset));
    const before = collapse(beforeCps.slice(-SSN_LABEL_LOOKBACK)).split(BANK_ACCT_PLACEHOLDER).join(neutral);
    const afterCps = Array.from(full.slice(offset + match.length));
    const after = collapse(afterCps.slice(0, SSN_LABEL_LOOKBACK)).split(BANK_ACCT_PLACEHOLDER).join(neutral);
    return BANK_LABEL_BEFORE.test(before) || BANK_LABEL_AFTER.test(after) ? BANK_ACCT_PLACEHOLDER : match;
  });
}

/**
 * Strip ANSI escape sequences and control characters from raw log bytes.
 *
 * MUST run BEFORE redactSSNForDisplay: an ANSI escape interleaved in a digit
 * run (e.g. a color reset emitted mid-number, `987\x1b[0m654321`) would break
 * the `\b\d{9}\b` boundary and let the bare-9 SSN evade the scrub if it ran on
 * raw bytes. Stripping first collapses the run back to `987654321` so the scrub
 * fires. The log route calls this, then slices the tail, then scrubs the tail.
 */
export function stripLogControlSequences(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?]?[0-9;]*[a-zA-Z]/g,
    '',
  );
  return (
    stripped
      // C0 controls (except \t \n \r) + DEL (\x7f) + C1 controls (\x80-\x9f).
      // The C1 range matters: 0x9b is a single-char CSI equivalent to ESC[, so
      // a C1-based escape would not be caught by the ESC-prefixed ANSI strip
      // above; and ANY of these interleaved in a digit run would split it and
      // let a bare-9 SSN evade the scrub that follows.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
      // Invisible / format Unicode by PROPERTY CLASS (not an enumeration):
      // \p{Cf} (soft hyphen, ZW space/joiners, LRM/RLM, bidi, word joiner, BOM,
      // invisible-math U+2061-2064, ALM, Hangul fillers \u2026) + \p{Default_Ignorable}
      // (variation selectors U+FE00-FE0F, U+034F \u2026). Any can sit invisibly
      // between two digits and split an SSN run. NOT \p{Mn}: nonspacing combining
      // marks include legit diacritics (caf\u00e9 \u2192 cafe would mangle real text); a
      // combining mark interleaved in a digit run is a documented LOW residual.
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
  );
}

export function redactSSNForDisplay(text: string): string {
  if (!text) return text;
  // Boundary anchors: digit-only negative lookbehind/lookahead, NOT `\b` —
  // mirrors SSN_LEAD/SSN_TRAIL in redactSSN, so an SSN glued to a letter/
  // underscore (`applicantId123-45-6789`, `ssn987654321`) is found, while a
  // 10+-digit run still has no sub-9. NOT digit-or-dash (a dash would make
  // `ssn-123-45-6789` survive). Phone safety is by 3-2-4 SHAPE.
  // Pass 1 — aggressive bare-9, invisibles tolerated between digits.
  let out = text.replace(
    new RegExp(`(?<![0-9])\\d(?:${INVIS}\\d){8}(?![0-9])`, 'gu'),
    SSN_PLACEHOLDER,
  );
  // Pass 2 — formatted SSN, invisibles tolerated between digits/separators; each
  // group stays EXACTLY 3/2/4 visible digits so a 10-digit phone does not match.
  out = out.replace(
    new RegExp(
      `(?<![0-9])${ssnDigits(3)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(4)}(?![0-9])`,
      'gu',
    ),
    SSN_PLACEHOLDER,
  );
  // Pass 3 — formatted EIN `\d{2}<sep>\d{7}`, invisibles tolerated. Runs AFTER
  // the SSN passes so a formatted SSN (3-2-4) is claimed first; the 2-7 group
  // shape can't match SSN's Pass 2 and SSN's bare-9 pass can't match a dashed
  // run, so this only fires on genuine formatted EINs. Mirrors formattedEinRegex
  // in src/utils/ssn-redaction.ts; same canonical-aggressive parity discipline.
  out = out.replace(
    new RegExp(
      `(?<![0-9])${ssnDigits(2)}${INVIS}${SSN_SEP}${INVIS}${ssnDigits(7)}(?![0-9])`,
      'gu',
    ),
    EIN_PLACEHOLDER,
  );
  // Pass 4 — labeled bank-account (4–17 digits, label-gated). Runs LAST so the
  // SSN/EIN placeholders are already bracketed; mirrors canonical's registry
  // order (SSN > EIN > … > bank-acct) and its label-required-even-aggressive
  // bank callback. A labeled non-9-length run → [REDACTED-BANK-ACCT]; an
  // unlabeled 4–17 digit run is untouched (no FP).
  out = redactBankAcctForDisplay(out);
  return out;
}

// HTML tags (rendered invisibly) OR invisibles, tolerated between SSN digits.
// The media `.md` preview runs `marked` (markdown → HTML), turning emphasis
// markers into tags, so a marker-split SSN in a `.md` reassembles in the
// rendered preview exactly like the Telegram case. Mirrors redactSSNMarkupAware
// in src/utils/ssn-redaction.ts (the dashboard cannot import it — Turbopack
// boundary). Aggressive (display surface: over-redacting a rare 9-digit id in a
// preview is the accepted tradeoff, same as redactSSNForDisplay).
const MARKUP = '(?:<[^>]*>|[\\p{Cf}\\p{Default_Ignorable_Code_Point}])*';
function markupDigits(n: number): string {
  return '\\d' + `(?:${MARKUP}\\d)`.repeat(n - 1);
}
// Strip HTML tags + invisibles so the bank-label window is tested on the
// RENDERED text (a marker/tag split inside `bank account` or between it and the
// digits must not defeat the label test). Mirrors STRIP_MARKUP in canonical.
const STRIP_MARKUP = /<[^>]*>|[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Markup-aware redaction for RENDERED HTML (the `.md` preview). Tolerates HTML
 *  tags between digits, redacting the whole SSN span; legit tags elsewhere stay. */
export function redactSSNForDisplayMarkup(html: string): string {
  if (!html) return html;
  let out = html.replace(
    new RegExp(`(?<![0-9])\\d(?:${MARKUP}\\d){8}(?![0-9])`, 'gu'),
    SSN_PLACEHOLDER,
  );
  out = out.replace(
    new RegExp(
      `(?<![0-9])${markupDigits(3)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(2)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(4)}(?![0-9])`,
      'gu',
    ),
    SSN_PLACEHOLDER,
  );
  // Formatted-EIN pass (markup-tolerant), parallel to redactSSNForDisplay Pass 3.
  out = out.replace(
    new RegExp(`(?<![0-9])${markupDigits(2)}${MARKUP}${SSN_SEP}${MARKUP}${markupDigits(7)}(?![0-9])`, 'gu'),
    EIN_PLACEHOLDER,
  );
  // Labeled bank-account pass (markup-tolerant). A 4–17 digit run with tags
  // tolerated between digits redacts to [REDACTED-BANK-ACCT] when a bank label is
  // within the window; the label test runs on a markup-STRIPPED window with a
  // wide raw lookback so tag inflation cannot push the label out. Mirrors the
  // bank pass in redactSSNForDisplay (and canonical's bank callback), closing the
  // labeled-bank-acct leak on the rendered `.md` media route too.
  const neutral = ' '.repeat(BANK_ACCT_PLACEHOLDER.length);
  out = out.replace(
    new RegExp(`(?<![0-9])\\d(?:${MARKUP}\\d){3,16}(?![0-9])`, 'gu'),
    (match: string, offset: number, full: string): string => {
      const before = full
        .slice(Math.max(0, offset - SSN_LABEL_LOOKBACK * 12), offset)
        .replace(STRIP_MARKUP, '')
        .split(BANK_ACCT_PLACEHOLDER)
        .join(neutral);
      const after = full
        .slice(offset + match.length, offset + match.length + SSN_LABEL_LOOKBACK * 12)
        .replace(STRIP_MARKUP, '')
        .split(BANK_ACCT_PLACEHOLDER)
        .join(neutral);
      return BANK_LABEL_BEFORE.test(before) || BANK_LABEL_AFTER.test(after)
        ? BANK_ACCT_PLACEHOLDER
        : match;
    },
  );
  return out;
}

// The five XML predefined named entities. A digit has NO named entity, so for
// SSN *detection* numeric refs are what matter; we decode the named ones too so
// the re-escape on emit is single (a pre-existing `&amp;` round-trips to `&amp;`
// instead of double-escaping to `&amp;amp;`).
const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode XML character references (named `&amp;`, decimal `&#NN;`, hex
 *  `&#xNN;`) to the characters a renderer would show. Unknown names and
 *  out-of-range code points are left as-is. */
function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, hex, dec, name) => {
    if (hex !== undefined || dec !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(XML_NAMED_ENTITIES, name) ? XML_NAMED_ENTITIES[name] : m;
  });
}

/** Re-escape the XML-special characters so scrubbed text stays valid SVG.
 *  Order matters: `&` first. `"`/`'` need no escaping in element text. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Redact SSNs in an SVG's TEXT-NODE content only — never inside a tag or
 * attribute, so geometry (path `d`, coordinates, ids, viewBox, transforms) is
 * never altered and the vector cannot be corrupted. The media route serves SVG
 * inline (image/svg+xml), so an SSN shown to the human in a `<text>`/`<tspan>`
 * must be redacted REGARDLESS of how it is ENCODED. SVG text has several
 * encodings that all RENDER to the same digits, so — same principle as the
 * markdown egress (redact the RENDERED form, not the source bytes) — we decode
 * each text node to its rendered value, covering all in one move (+ any future
 * encoding):
 *   1. raw char-data between tags (`>123-45-6789<`)
 *   2. CDATA sections (`<![CDATA[123-45-6789]]>`)
 *   3. numeric/hex character references (`&#49;&#50;&#51;-45-6789`, `&#x31;…`)
 *
 * A text run is REWRITTEN only when its rendered value actually contains an SSN;
 * on rewrite the output is re-escaped (`& < >`) so it stays valid SVG and a
 * pre-existing named entity is not double-escaped. A no-SSN node is returned
 * BYTE-IDENTICAL (legit entities are never un-escaped). CDATA content is already
 * literal/rendered, so it is scrubbed in place (no decode/re-escape). Tag
 * interiors/attributes are never decoded or scrubbed. Accepted narrow residual:
 * an SSN whose digits straddle two adjacent tags (split across `<tspan>`s).
 */
export function redactSVGText(svg: string): string {
  if (!svg) return svg;
  // 1) CDATA sections: content is LITERAL text (entities are NOT decoded inside
  //    CDATA per XML — `&#49;` renders as the literal "&#49;"), so scrub the raw
  //    content directly, no decode/re-escape. Done first so the text-run pass
  //    below cannot re-touch CDATA interiors.
  let out = svg.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, content: string) => {
    const scrubbed = redactSSNForDisplay(content);
    return scrubbed === content ? _m : `<![CDATA[${scrubbed}]]>`;
  });
  // 2) Raw text-node char-data between tags. Decode to the rendered value
  //    (named + numeric + hex), scrub, and rewrite ONLY when an SSN was found —
  //    re-escaping the result so it is valid SVG. No-SSN runs return original
  //    bytes (entities preserved, never un-escaped).
  out = out.replace(/>([^<]+)</g, (m, chars: string) => {
    const decoded = decodeXmlEntities(chars);
    const scrubbed = redactSSNForDisplay(decoded);
    return scrubbed === decoded ? m : `>${escapeXmlText(scrubbed)}<`;
  });
  return out;
}
