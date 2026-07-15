/**
 * Media route content-type tables + the text-vs-binary gate, extracted to a pure
 * module (no next/server imports) so the alignment invariant between the
 * extension-based inline-serve set and the MIME-based SSN-scrub gate can be
 * unit-tested directly (the route test cannot run locally — it imports
 * next/server). See media-content-types.test.ts.
 */

export const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  // SECURITY: .html/.htm are deliberately served as text/plain, NOT text/html.
  // Agent-written HTML served inline as text/html would execute scripts on the
  // dashboard origin (stored XSS → auth-cookie theft). The dashboard's own
  // HTML preview (deliverable-preview.tsx) fetches the body as text and renders
  // it in a sandboxed srcDoc iframe, so it does not rely on this content type.
  '.html': 'text/plain; charset=utf-8',
  '.htm': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
export const INLINE_EXTENSIONS = new Set([
  '.md',
  '.html',
  '.htm',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.css',
  '.sh',
  '.json',
  '.csv',
]);

/**
 * The text-vs-binary gate for the media route's raw serve branch. TEXT content
 * (text/* or application/json) is decoded and SSN-scrubbed before going
 * off-host; binary content (images/pdf/audio/video/octet-stream) is served
 * byte-identical. Tolerates a `; charset=...` suffix on the MIME string.
 */
export function isTextContentType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json';
}
