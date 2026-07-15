import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { getCTXRoot, getFrameworkRoot, getAllowedRootsConfigPath } from '@/lib/config';
import { redactSSNForDisplay, redactSSNForDisplayMarkup, redactSVGText } from '@/lib/redact-ssn';
import { MIME_TYPES, IMAGE_EXTENSIONS, INLINE_EXTENSIONS, isTextContentType } from '@/lib/media-content-types';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Allowed roots — controls which directories the media API can serve from.
//
// CTX_ROOT is always implicitly allowed. Additional directories can be added
// via Settings > Allowed Roots so agents can reference files from project
// trees outside the default runtime directory. The list is stored in
// {CTX_ROOT}/config/allowed-roots.json and read on every request.
// ---------------------------------------------------------------------------

interface AllowedRootsFile {
  additional_roots?: string[];
}

function readAllowedRoots(): string[] {
  const configPath = getAllowedRootsConfigPath();
  if (!fs.existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AllowedRootsFile;
    if (!Array.isArray(parsed.additional_roots)) return [];
    return parsed.additional_roots.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

function isPathUnderAnyRoot(realPath: string, roots: string[]): boolean {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    if (realPath === realRoot) return true;
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realPath.startsWith(rootWithSep)) return true;
  }
  return false;
}


// ---------------------------------------------------------------------------
// Sensitive-file denylist.
//
// SECURITY: agent directories under the allowed roots contain credential
// files (.env with BOT_TOKEN/CHAT_ID, key material, secrets files). Without
// this check, GET /api/media/orgs/<org>/agents/<name>/.env would serve the
// agent's credentials to any authenticated dashboard user.
//
// The check is applied to the basename of the RESOLVED real path (after
// fs.realpathSync), so `..` traversal, URL-encoding tricks, and symlinks
// pointing at a blocked file cannot smuggle a blocked name past the filter.
// Only the final segment is checked: files that merely live inside a dot
// directory (e.g. .claude/skills/foo/SKILL.md) remain servable.
// ---------------------------------------------------------------------------
const BLOCKED_KEY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

function isSensitiveBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  // All dotfiles: .env, .env.local, .env.production, .npmrc, .netrc, ...
  if (lower.startsWith('.')) return true;
  // secrets, secrets.json, secrets-prod.yaml, ...
  if (lower.startsWith('secrets')) return true;
  // Private key / cert-bundle material by extension.
  if (BLOCKED_KEY_EXTENSIONS.has(path.extname(lower))) return true;
  return false;
}

/**
 * GET /api/media/[...filepath]
 * Serve a local file by its path relative to CTX_ROOT (or an absolute path
 * if it falls within an allowed root). Supports ?render=true for markdown
 * files to return rendered HTML instead of raw text.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filepath: string[] }> }
) {
  const { filepath } = await params;
  const ctxRoot = getCTXRoot();

  // Reconstruct the relative path from the URL segments.
  const relativePath = filepath.join('/');
  const frameworkRoot = getFrameworkRoot();
  const additionalRoots = readAllowedRoots();
  const validRoots = [ctxRoot, frameworkRoot, ...additionalRoots];

  // Resolve the file against configured roots in two passes.
  //
  // Pass 1 — direct resolve: path.resolve(root, relativePath).
  // Works when the file sits directly under the root.
  //
  // Pass 2 — overlap-stripped resolve: when a root's tail matches the
  // relative path's head, strip the overlap to avoid doubling path
  // components. Example: root "C:/x/orgs/foo" + rel "orgs/foo/bar.md"
  // → pass 1 tries "C:/x/orgs/foo/orgs/foo/bar.md" (wrong),
  // → pass 2 strips "orgs/foo" overlap → "C:/x/orgs/foo/bar.md" (correct).
  //
  // Both passes enforce the same security check: the resolved real path
  // must fall within a configured allowed root.
  let realFullPath: string | null = null;

  function tryResolve(candidate: string): boolean {
    try {
      const real = fs.realpathSync(candidate);
      if (isPathUnderAnyRoot(real, validRoots)) {
        realFullPath = real;
        return true;
      }
    } catch {
      // File doesn't exist at this path
    }
    return false;
  }

  // Pass 1: direct resolve
  for (const root of validRoots) {
    if (tryResolve(path.resolve(root, relativePath))) break;
  }

  // Pass 2: overlap-stripped resolve
  if (!realFullPath) {
    const relParts = relativePath.split('/');
    for (const root of validRoots) {
      const rootParts = root.replace(/\\/g, '/').split('/');
      const maxOverlap = Math.min(rootParts.length, relParts.length);
      for (let n = maxOverlap; n > 0; n--) {
        const rootTail = rootParts.slice(-n).join('/').toLowerCase();
        const relHead = relParts.slice(0, n).join('/').toLowerCase();
        if (rootTail === relHead) {
          const stripped = relParts.slice(n).join('/');
          if (!stripped) continue;
          if (tryResolve(path.resolve(root, stripped))) break;
        }
      }
      if (realFullPath) break;
    }
  }

  if (!realFullPath) {
    // Suggest which directory to add based on the first root candidate tried
    const suggestedDir = path.dirname(path.resolve(ctxRoot, relativePath)).replace(/\\/g, '/');
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: `File not found under any configured root. To fix: go to Settings > Allowed Roots and add the directory that contains this file (e.g. "${suggestedDir}"), or re-attach as a snapshot via save-output.`,
        configured_roots: validRoots,
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // SECURITY: refuse to serve secrets/dotfiles/key material even when they
  // resolve under a valid root. Checked on the resolved basename (post-
  // realpath, post-symlink) so it cannot be bypassed via `..` or encoding.
  // Responds with the same 404 shape as a resolution miss so the route does
  // not act as a file-existence oracle for blocked names.
  if (isSensitiveBasename(path.basename(realFullPath))) {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: 'File not found under any configured root.',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // SECURITY: the agent log directory (CTX_ROOT/logs) is served EXCLUSIVELY by
  // the dedicated /api/agents/[name]/logs route, which scrubs SSNs at the read
  // boundary. This generic file server resolves any path under CTX_ROOT and
  // serves it raw (octet-stream), with no scrub — so without this guard it is a
  // SECOND, UNSCRUBBED door to stdout.log/stderr.log (the PTY Layer-1 holdback
  // leaves bounded SSN residuals in those files). Deny anything resolving under
  // CTX_ROOT/logs so the scrubbed logs route is the exclusive door. Same 404
  // shape as a miss, so the route is not a file-existence oracle. Checked on
  // the realpath'd path so `..`/symlinks cannot bypass it.
  if (isPathUnderAnyRoot(realFullPath, [path.join(ctxRoot, 'logs')])) {
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: 'File not found under any configured root.',
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const ext = path.extname(realFullPath).toLowerCase();
  const renderMd = _request.nextUrl.searchParams.get('render') === 'true';

  // Markdown render mode: convert to HTML fragment for the preview panel.
  // Agent-generated markdown can contain raw inline HTML (e.g. <script>,
  // onerror handlers, javascript: URIs). We sanitize the marked output with
  // DOMPurify before returning it so the client can safely inject it via
  // dangerouslySetInnerHTML. FORBID_TAGS covers the dangerous vectors that
  // the default DOMPurify config doesn't already strip on some configs.
  if (renderMd && ext === '.md') {
    const mdContent = fs.readFileSync(realFullPath, 'utf-8');
    const rawHtml = marked.parse(mdContent) as string;
    const sanitized = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'formaction'],
    });
    // SECURITY: scrub SSNs from the RENDERED markdown before it goes off-host.
    // marked turns emphasis markers into tags, so an SSN split by a marker in the
    // .md (`123-45-*6789*`) reassembles in the preview — redactSSNForDisplayMarkup
    // tolerates tags between digits and redacts the whole span (same class as the
    // Telegram markdown egress). This .md preview branch previously had NO scrub.
    const htmlBody = redactSSNForDisplayMarkup(sanitized);
    return new Response(htmlBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(htmlBody)),
        'Cache-Control': 'private, max-age=60',
      },
    });
  }

  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  // SECURITY: scrub SSNs from served content before it goes off-host. Three
  // body shapes:
  //   1. TEXT content (text/* or application/json) — the renderMd branch above
  //      scrubs only the ?render=true preview; this raw fallthrough serves
  //      .md/.txt/.csv/etc. VERBATIM (the "Open file in new tab" door). Scrub
  //      with redactSSNForDisplay (the same aggressive scrubber the logs route
  //      uses). Body = scrubbed string.
  //   2. SVG (image/svg+xml) — not text-gated, but it is XML text served inline
  //      that can carry an SSN in <text>/<tspan> element content. redactSVGText
  //      scrubs ONLY element text, never geometry (path d=, coords, viewBox), so
  //      the vector is not corrupted. Body = scrubbed string. (This closes the
  //      previously-documented SVG residual.)
  //   3. BINARY (images/pdf/audio/video/octet-stream) — no text SSN; served
  //      byte-identical. Body = Uint8Array. `new Uint8Array(buf)` (copy form):
  //      a Node Buffer is typed `Buffer<ArrayBufferLike>` and does NOT satisfy
  //      BodyInit's `ArrayBufferView<ArrayBuffer>` under TS 5.7+; the fresh
  //      allocation is `Uint8Array<ArrayBuffer>` (valid BodyInit). The copy is
  //      byte-identical and bounded to the Buffer's own length (copies the
  //      Buffer's view, never the pooled backing ArrayBuffer — no over-read).
  let textBody: string | null = null;
  let binaryBody: Uint8Array<ArrayBuffer> | null = null;
  if (isTextContentType(mimeType)) {
    textBody = redactSSNForDisplay(fs.readFileSync(realFullPath, 'utf-8'));
  } else if (ext === '.svg') {
    textBody = redactSVGText(fs.readFileSync(realFullPath, 'utf-8'));
  } else {
    binaryBody = new Uint8Array(fs.readFileSync(realFullPath));
  }
  const contentLength =
    textBody !== null ? Buffer.byteLength(textBody) : (binaryBody as Uint8Array<ArrayBuffer>).length;

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(contentLength),
    'Cache-Control': 'private, max-age=3600',
    // SECURITY: prevent browsers from MIME-sniffing text/plain responses
    // (e.g. .html served as text/plain above) back into executable HTML.
    'X-Content-Type-Options': 'nosniff',
  };

  // SECURITY: defense-in-depth for document types that can execute script on
  // the dashboard origin when navigated to directly. CSP `sandbox` puts the
  // response in an opaque origin with scripts disabled. SVG renders fine as
  // <img> (where scripts never run) and inline markup still displays; this
  // only constrains direct navigation.
  if (ext === '.html' || ext === '.htm' || ext === '.svg') {
    headers['Content-Security-Policy'] = 'sandbox';
  }

  if (IMAGE_EXTENSIONS.has(ext) || INLINE_EXTENSIONS.has(ext)) {
    headers['Content-Disposition'] = `inline; filename="${path.basename(realFullPath)}"`;
  } else {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(realFullPath)}"`;
  }

  // Separate typed Response per branch — string and Uint8Array<ArrayBuffer> are
  // each assignable to BodyInit on their own; a string|bytes union is not.
  return textBody !== null
    ? new Response(textBody, { status: 200, headers })
    : new Response(binaryBody as Uint8Array<ArrayBuffer>, { status: 200, headers });
}
