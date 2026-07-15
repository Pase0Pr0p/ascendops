/**
 * Alignment invariant for the media route's SSN-scrub gate.
 *
 * The media route serves a fixed set of extensions INLINE (INLINE_EXTENSIONS,
 * extension-based) and scrubs SSNs from raw content via a MIME-based gate
 * (isTextContentType). These two sets must stay aligned: every extension served
 * inline as text MUST map to a gated (scrubbed) MIME, or a future inline ext
 * with a non-text MIME would silently serve un-scrubbed off-host. This test
 * locks that invariant so the two cannot drift (the gap an independent reviewer
 * caught on the first media fix). Pure module — no next/server — so it runs
 * locally AND in CI, unlike the route test.
 */
import { describe, it, expect } from 'vitest';
import { MIME_TYPES, IMAGE_EXTENSIONS, INLINE_EXTENSIONS, isTextContentType } from '../media-content-types';

describe('media content-types — scrub-gate alignment invariant', () => {
  it('every INLINE_EXTENSION maps to a known MIME type', () => {
    for (const ext of INLINE_EXTENSIONS) {
      expect(MIME_TYPES[ext], `MIME_TYPES is missing inline ext ${ext}`).toBeDefined();
    }
  });

  it('every INLINE_EXTENSION maps to a text-gated (scrubbed) MIME', () => {
    // This is the load-bearing invariant: an inline-served text extension that
    // is NOT text-gated would serve raw content un-scrubbed off-host.
    for (const ext of INLINE_EXTENSIONS) {
      expect(
        isTextContentType(MIME_TYPES[ext]),
        `inline ext ${ext} (${MIME_TYPES[ext]}) is served inline but NOT scrub-gated`,
      ).toBe(true);
    }
  });

  it('isTextContentType tolerates a charset suffix', () => {
    expect(isTextContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isTextContentType('text/csv; charset=utf-8')).toBe(true);
    expect(isTextContentType('application/json')).toBe(true);
  });

  it('binary/image MIME types are NOT text-gated (served byte-identical)', () => {
    for (const mime of ['image/png', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/mpeg', 'application/octet-stream']) {
      expect(isTextContentType(mime), `${mime} must not be text-gated`).toBe(false);
    }
  });

  it('SVG is image/svg+xml and NOT text-gated (handled by the SVG-text-only path, not the raw text gate)', () => {
    expect(MIME_TYPES['.svg']).toBe('image/svg+xml');
    expect(isTextContentType(MIME_TYPES['.svg'])).toBe(false);
    expect(IMAGE_EXTENSIONS.has('.svg')).toBe(true);
    expect(INLINE_EXTENSIONS.has('.svg')).toBe(false);
  });
});
