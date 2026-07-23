#!/usr/bin/env node
/**
 * forge-candidates.mjs — durable candidate queue plumbing for the forge skill.
 *
 * The forge detect pass (nightly, unattended) finds skill-drift candidates and
 * MUST persist them durably before the session ends (forge SKILL.md step 2).
 * The forge build pass (weekly) reads the accumulated queue (SKILL.md step 3).
 * This script is the mechanical layer for both:
 *
 *   emit     Persist ONE candidate durably: append to the run-log queue
 *            (docs/ephemeral/forge-runs/candidates.md) FIRST, then log a
 *            `forge_candidate` bus event (category: action). Dual-store —
 *            either one alone survives; together they cross-check.
 *            Refuses candidates with no tied real incident (forge hard rule 1).
 *
 *   queue    Read the accumulated queue: forge_candidate events since the last
 *            build marker + pending candidates.md entries, dedupe (event id),
 *            group by create-vs-edit verdict. Output md (default) or JSON.
 *
 *   consume  Archive the pending queue into runs/<build-id>.md and advance the
 *            .last-build marker. Run ONLY after the weekly build assembled its
 *            gated change-set from the queue.
 *
 * Events are read from:   ${CTX_ROOT}/orgs/${CTX_ORG}/analytics/events/<agent>/<date>.jsonl
 * Run log lives at:       ${CTX_FRAMEWORK_ROOT}/orgs/${CTX_ORG}/docs/ephemeral/forge-runs/
 * Both are overridable (--events-root, --runs-dir) so tests and other orgs work.
 *
 * No external dependencies. Tolerates both observed forge_candidate metadata
 * shapes (rich 2026-06-07 shape: skill/slippage/verdict/incident; slim
 * 2026-06-08 shape: candidate/source/date).
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERDICTS = ['create-new', 'edit-existing'];

function usage() {
  return `Usage: node scripts/forge-candidates.mjs <emit|queue|consume> [options]

emit — persist one HIGH candidate durably (run-log append + forge_candidate event)
  --slippage "<what slipped>"        REQUIRED. The slippage / by-hand pattern.
  --incident "<meld/PR/date>"        REQUIRED. Tied REAL incident (forge hard rule 1).
  --verdict create-new|edit-existing REQUIRED. Create-vs-edit verdict.
  --skill <name>                     Target skill (edit-existing) or proposed name (create-new).
  --rule "<proposed hard rule>"      The rule the built skill must bake in.
  --confidence high|medium|low       Default: high (detect persists HIGH only).
  --source <text>                    Where it surfaced (agent, transcript, review).
  --meta '<json>'                    Extra metadata merged into the event payload.
  --no-event                         Skip the bus event (run-log append only).
  --runs-dir <dir>                   Override forge-runs dir.

queue — read the accumulated queue for the weekly build
  --since <YYYY-MM-DD>               Override window start (default: .last-build marker,
                                     else 14 days back).
  --format md|json                   Default: md.
  --events-root <dir>                Override events root.
  --runs-dir <dir>                   Override forge-runs dir.

consume — archive pending entries after a build pass
  --build-id <id>                    Default: build-<today>.
  --runs-dir <dir>                   Override forge-runs dir.
`;
}

function envDefaults() {
  const ctxRoot = process.env.CTX_ROOT || join(process.env.HOME || '', '.cortextos', 'default');
  const org = process.env.CTX_ORG;
  if (!org) {
    console.error('FATAL: CTX_ORG is not set. Forge reads org-nested events at orgs/${CTX_ORG}/analytics/events/. Without it, events resolve to the wrong path and return 0 despite real activity. Set CTX_ORG before running.');
    process.exit(1);
  }
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
  return {
    org,
    eventsRoot: join(ctxRoot, 'orgs', org, 'analytics', 'events'),
    runsDir: join(frameworkRoot, 'orgs', org, 'docs', 'ephemeral', 'forge-runs'),
    frameworkRoot,
  };
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--no-event') {
      opts.noEvent = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = rest[++i];
    } else {
      opts._.push(arg);
    }
  }
  return { cmd, opts };
}

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

function candidatesPath(runsDir) {
  return join(runsDir, 'candidates.md');
}

function markerPath(runsDir) {
  return join(runsDir, '.last-build');
}

function snapshotPath(runsDir) {
  return join(runsDir, '.pending-build.json');
}

const SCAFFOLD_HEADER = `# Forge candidate queue (durable)

Source-of-truth run log the weekly forge build reads, alongside \`forge_candidate\`
bus events. Written by the nightly detect pass (unattended) via
\`scripts/forge-candidates.mjs emit\`. Consumed (archived to \`runs/\`) by the weekly
build via \`consume\`. Every entry MUST tie to a real incident — no speculative
skills (forge hard rule 1).

Entry format: one \`### fc-<id>\` block per candidate with \`key: value\` bullets
(date, skill, verdict, confidence, incident, slippage, rule, source, event_id).

## Pending
`;

function ensureQueueFile(runsDir) {
  mkdirSync(runsDir, { recursive: true });
  const path = candidatesPath(runsDir);
  if (!existsSync(path)) {
    writeFileSync(path, SCAFFOLD_HEADER, 'utf-8');
  }
  return path;
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 7);
}

export function formatEntry(c) {
  const lines = [`### ${c.id}`];
  const fields = ['date', 'emitted_at', 'skill', 'verdict', 'confidence', 'incident', 'slippage', 'rule', 'source', 'event_id'];
  for (const f of fields) {
    if (c[f]) lines.push(`- ${f}: ${String(c[f]).replace(/\n/g, ' ')}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** Parse candidates.md into { header, pending:[entries], rest } */
export function parseQueueFile(text) {
  const pendingIdx = text.indexOf('## Pending');
  if (pendingIdx === -1) return { pending: [] };
  const body = text.slice(pendingIdx);
  const pending = [];
  const blockRe = /^### (fc-[^\n]+)\n((?:- [^\n]*\n?)*)/gm;
  let m;
  while ((m = blockRe.exec(body)) !== null) {
    const entry = { id: m[1].trim() };
    for (const line of m[2].split('\n')) {
      const kv = line.match(/^- ([a-z_]+): (.*)$/);
      if (kv) entry[kv[1]] = kv[2].trim();
    }
    pending.push(entry);
  }
  return { pending };
}

// ---------------------------------------------------------------- emit ----

export function emitCandidate(opts, defaults = envDefaults()) {
  const runsDir = resolve(opts.runsDir || defaults.runsDir);
  const errors = [];
  if (!opts.slippage) errors.push('--slippage is required (what actually slipped)');
  if (!opts.incident) {
    errors.push('--incident is required — every candidate ties to a REAL incident (meld/PR/date). No speculative skills (forge hard rule 1).');
  }
  if (!opts.verdict || !VERDICTS.includes(opts.verdict)) {
    errors.push(`--verdict must be one of: ${VERDICTS.join(', ')}`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  let extra = {};
  if (opts.meta) {
    try {
      extra = JSON.parse(opts.meta);
    } catch {
      return { ok: false, errors: ['--meta is not valid JSON'] };
    }
  }

  const candidate = {
    id: `fc-${Math.floor(Date.now() / 1000)}-${randomSuffix()}`,
    date: todayUTC(),
    // Precise ISO axis for cutoff windowing in buildQueue (coarse `date` still
    // drives the consumed_through date window). ISO-8601 UTC strings sort
    // lexicographically, so string compare against the cutoff is correct.
    emitted_at: new Date().toISOString(),
    skill: opts.skill || '',
    verdict: opts.verdict,
    confidence: opts.confidence || 'high',
    incident: opts.incident,
    slippage: opts.slippage,
    rule: opts.rule || '',
    source: opts.source || process.env.CTX_AGENT_NAME || '',
  };

  // 1) Durable run-log append FIRST — detect runs unattended; this must
  //    survive the session even if the bus emit fails (PR #104 P2 lesson).
  const queueFile = ensureQueueFile(runsDir);
  appendFileSync(queueFile, formatEntry(candidate), 'utf-8');

  // 2) Bus event (preferred store the cost-guard and weekly build sweep).
  let eventResult = 'skipped (--no-event)';
  if (!opts.noEvent) {
    const meta = JSON.stringify({ ...extra, ...candidate });
    const attempts = [
      ['cortextos', ['bus', 'log-event', 'action', 'forge_candidate', 'info', '--meta', meta]],
      ['node', [join(defaults.frameworkRoot, 'dist', 'cli.js'), 'bus', 'log-event', 'action', 'forge_candidate', 'info', '--meta', meta]],
    ];
    eventResult = 'FAILED — run-log entry persisted; re-emit the event manually';
    for (const [bin, args] of attempts) {
      const res = spawnSync(bin, args, { encoding: 'utf-8' });
      if (res.status === 0) {
        eventResult = 'logged';
        break;
      }
    }
  }

  return { ok: true, candidate, queueFile, eventResult };
}

// --------------------------------------------------------------- queue ----

function readMarker(runsDir) {
  try {
    return JSON.parse(readFileSync(markerPath(runsDir), 'utf-8'));
  } catch {
    return null;
  }
}

function fourteenDaysAgo() {
  return new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().split('T')[0];
}

export function readEvents(eventsRoot, since) {
  const out = [];
  if (!existsSync(eventsRoot)) return out;
  for (const agent of readdirSync(eventsRoot)) {
    const dir = join(eventsRoot, agent);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m || m[1] < since) continue;
      const lines = readFileSync(join(dir, file), 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.includes('"forge_candidate"')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'forge_candidate') out.push(ev);
        } catch {
          // skip malformed line — events are append-only JSONL, partial last line possible
        }
      }
    }
  }
  return out;
}

/** Normalize both observed metadata shapes into the queue entry shape. */
export function normalizeEvent(ev) {
  const md = ev.metadata || {};
  return {
    // Prefer the candidate's own fc-id when emit stamped it into the event
    // metadata — that id ALSO labels the run-log entry, so dedupe can match the
    // two stores. Fall back to the bus event id for events not minted by emit.
    id: md.id || `fc-event-${ev.id}`,
    event_id: ev.id,
    // Carry the candidate's own emit stamp so the normalized event keys on the
    // same per-candidate timestamp the run-log twin and the build window use.
    emitted_at: md.emitted_at || ev.timestamp || '',
    date: (ev.timestamp || '').split('T')[0],
    skill: md.skill || md.candidate || '',
    verdict: VERDICTS.includes(md.verdict) ? md.verdict : '',
    confidence: md.confidence || '',
    incident: md.incident || md.incidents || md.date || '',
    slippage: md.slippage || md.pattern || md.source || '',
    rule: md.rule || md.note || '',
    source: ev.agent || '',
  };
}

export function buildQueue({ eventsRoot, runsDir, since }) {
  // Read the consume marker once: `consumed_through` (date) is the coarse
  // file-level window; `consumed_through_ts` (precise ISO) is the event-level
  // watermark that excludes candidates already consumed on the SAME UTC day —
  // the date-only filter alone re-reads that day's JSONL after consume resets
  // candidates.md, so same-day consumed events would otherwise reappear (P1).
  // ONE authoritative cutoff, captured BEFORE readEvents — the build-read
  // boundary. Threaded into the event upper-bound (below), the snapshot
  // build_start_ts, and the consume watermark (all via the returned cutoffTs).
  // Capturing it pre-scan is load-bearing: an event appended at/after this
  // moment (during or after the scan) has ts > cutoff, so it is neither pulled
  // into this build NOR marked consumed — it surfaces in the NEXT build.
  // Stamping it AFTER the scan (the prior bug) let scan-to-stamp-gap arrivals
  // fall below the watermark and be silently dropped.
  const cutoffTs = new Date().toISOString();
  const marker = since ? null : readMarker(runsDir);
  const sinceDate = since || marker?.consumed_through || fourteenDaysAgo();
  const watermarkTs = marker?.consumed_through_ts || null;
  const events = readEvents(eventsRoot, sinceDate)
    // Window on the candidate's OWN emit stamp (meta.emitted_at), NOT the bus-
    // assigned ev.timestamp. emit stamps emitted_at at construction, then appends
    // the run-log entry, then logs the bus event — so ev.timestamp is strictly
    // LATER than emitted_at. Keying the event on ev.timestamp while the run-log
    // twin keys on emitted_at lets one straddling emit fall on opposite sides of
    // the cutoff (fileEntry IN, event OUT), splitting the dedup partners across
    // builds = duplicate. Using meta.emitted_at makes BOTH stores key on the SAME
    // per-candidate stamp, so they always agree. Fall back to ev.timestamp for
    // pre-unified-store events with no meta.emitted_at; a stampless event is kept.
    // Lower bound strict `>` (already-consumed), upper bound `<=` (next build).
    .filter((ev) => {
      const stamp = ev.metadata?.emitted_at || ev.timestamp;
      return !stamp || ((!watermarkTs || stamp > watermarkTs) && stamp <= cutoffTs);
    })
    .map(normalizeEvent);
  // UNIFIED-STORE: run-log (candidates.md) entries are now bounded by the SAME
  // authoritative cutoff as events. Each emit stamps a precise ISO `emitted_at`
  // (see emitCandidate), so a file entry appended in the window between the
  // cutoff capture and this read has `emitted_at > cutoffTs` and is deferred to
  // the NEXT build — neither pulled in early NOR (via consume) archived early.
  // Both stores now share one cutoff, closing the prior date-only asymmetry.
  // Back-compat: entries written before this change have no `emitted_at` and
  // cannot be windowed, so they are kept (same rule as a timestamp-less event).
  let fileEntries = [];
  const qPath = candidatesPath(runsDir);
  if (existsSync(qPath)) {
    fileEntries = parseQueueFile(readFileSync(qPath, 'utf-8')).pending
      // UPPER bound ONLY (`<= cutoff`): defer an entry appended at/after this
      // build's read so it lands in the NEXT build. NO watermark lower bound here
      // — that is an EVENT-store mechanism: events are append-only, so a consumed
      // event must be watermark-filtered to avoid re-reading it. File entries are
      // physically REMOVED by id at consume, so any entry STILL in candidates.md
      // is by-definition not-yet-consumed (it may have been preserved because it
      // arrived after a build read). Applying the lower bound here would silently
      // DROP such a preserved entry once the marker advanced past its emit stamp —
      // and a `--no-event` entry has no event copy to recover it. No `emitted_at`
      // (pre-unified-store) → keep.
      .filter((e) => !e.emitted_at || e.emitted_at <= cutoffTs);
  }
  // Dedupe across the two stores. emit dual-persists: the run-log entry is keyed
  // by the candidate's own fc-id, and the forge_candidate event carries that SAME
  // id in its metadata (normalizeEvent surfaces it as `.id`). So a file entry
  // supersedes the matching event. Also honor event_id when a run-log entry
  // recorded one. The run-log (durable, written first) always wins on a tie.
  const seenIds = new Set(fileEntries.map((e) => e.id).filter(Boolean));
  const seenEventIds = new Set(fileEntries.map((e) => e.event_id).filter(Boolean));
  const merged = [
    ...fileEntries,
    ...events.filter((e) => !seenIds.has(e.id) && !seenEventIds.has(e.event_id)),
  ];
  const groups = {
    'create-new': merged.filter((e) => e.verdict === 'create-new'),
    'edit-existing': merged.filter((e) => e.verdict === 'edit-existing'),
    'needs-verdict': merged.filter((e) => !VERDICTS.includes(e.verdict)),
  };
  return { since: sinceDate, cutoffTs, total: merged.length, groups };
}

export function renderQueueMd(queue) {
  const lines = [
    `# Forge build queue (accumulated since ${queue.since})`,
    '',
    `${queue.total} candidate(s). Methods per forge SKILL.md step 3: create-new = auto-skill method, edit-existing = skill-optimizer method. Assemble SPECS + change-sets — never auto-merge (hard rule 7).`,
  ];
  const sections = [
    ['create-new', '## Create-new (auto-skill method)'],
    ['edit-existing', '## Edit-existing (skill-optimizer method)'],
    ['needs-verdict', '## Needs create-vs-edit verdict first'],
  ];
  for (const [key, title] of sections) {
    const entries = queue.groups[key];
    if (entries.length === 0) continue;
    lines.push('', title, '');
    for (const e of entries) {
      lines.push(formatEntry(e).trimEnd(), '');
    }
  }
  if (queue.total === 0) lines.push('', 'Queue is empty — no build needed.');
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------- consume ----

export function consumeQueue({ runsDir, eventsRoot, buildId }) {
  const id = buildId || `build-${todayUTC()}`;
  const qPath = candidatesPath(runsDir);
  const snapPath = snapshotPath(runsDir);

  // Bind consume to the build-START snapshot written by the preceding `queue`
  // read: archive EXACTLY that candidate set and advance the watermark to the
  // snapshot's build_start_ts (T1) — NOT consume-time (T2). This closes the
  // build/consume TOCTOU: a forge_candidate emitted between the queue-read (T1)
  // and consume (T2) is NOT in the snapshot, so it is neither archived-as-
  // consumed nor watermark-excluded — it survives into the next build.
  // Fallback (no snapshot = ad-hoc consume with no preceding queue): recompute
  // the merged queue live with watermark = now. This is the only path the race
  // could touch, and it is non-standard (the weekly flow always runs `queue`
  // first). The fallback still archives event-only candidates (the earlier #3
  // fix) rather than candidates.md alone.
  let consumed;
  let watermarkTs;
  if (existsSync(snapPath)) {
    let snap = null;
    try {
      snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
    } catch {
      snap = null;
    }
    if (snap && Array.isArray(snap.candidates) && snap.build_start_ts) {
      consumed = snap.candidates;
      watermarkTs = snap.build_start_ts;
    }
  }
  if (!consumed) {
    const queue = buildQueue({ eventsRoot: eventsRoot || envDefaults().eventsRoot, runsDir });
    consumed = [
      ...queue.groups['create-new'],
      ...queue.groups['edit-existing'],
      ...queue.groups['needs-verdict'],
    ];
    // Use the SAME pre-read cutoff buildQueue used for its upper-bound, so the
    // watermark matches exactly what was read (no scan-to-watermark gap).
    watermarkTs = queue.cutoffTs;
  }

  const runsArchiveDir = join(runsDir, 'runs');
  mkdirSync(runsArchiveDir, { recursive: true });
  const archivePath = join(runsArchiveDir, `${id}.md`);
  const archived = [
    `# Forge build run ${id}`,
    '',
    `Consumed ${consumed.length} candidate(s) on ${new Date().toISOString()}.`,
    '',
    ...consumed.map((e) => formatEntry(e).trimEnd()),
    '',
  ].join('\n');
  writeFileSync(archivePath, archived, 'utf-8');

  // INVARIANT: consume removes from the run log ONLY the entries that were in
  // the consumed snapshot set, and preserves everything else. A candidates.md
  // entry appended AFTER the snapshot (an `emit --no-event`, or an emit whose
  // bus event failed, landing between the queue-read and consume) exists ONLY
  // in the run log with no event to recover from — a blanket scaffold reset
  // would silently drop it. Rewriting with the NON-consumed remainder enforces
  // "consume only ever touches what was actually built" directly (the property
  // the watermark / TOCTOU / blanket-reset bugs each violated a different way).
  const consumedIds = new Set(consumed.map((c) => c.id).filter(Boolean));
  const remaining = existsSync(qPath)
    ? parseQueueFile(readFileSync(qPath, 'utf-8')).pending.filter((e) => !consumedIds.has(e.id))
    : [];
  writeFileSync(qPath, SCAFFOLD_HEADER + remaining.map((e) => formatEntry(e)).join(''), 'utf-8');
  if (existsSync(snapPath)) rmSync(snapPath, { force: true });
  writeFileSync(
    markerPath(runsDir),
    // consumed_through (date) + consumed_through_ts (ISO) come from the
    // BUILD-START moment, not consume-time, so candidates emitted after the
    // build read survive the next queue (build/consume TOCTOU fix). The date is
    // the coarse file window; the ts is the precise event watermark (P1).
    `${JSON.stringify({ build_id: id, consumed_through: watermarkTs.split('T')[0], consumed_through_ts: watermarkTs, consumed: consumed.length })}\n`,
    'utf-8',
  );
  return { ok: true, buildId: id, consumed: consumed.length, archivePath };
}

// ---------------------------------------------------------------- main ----

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const defaults = envDefaults();
  const runsDir = resolve(opts.runsDir || defaults.runsDir);
  const eventsRoot = resolve(opts.eventsRoot || defaults.eventsRoot);

  if (cmd === 'emit') {
    const result = emitCandidate(opts, defaults);
    if (!result.ok) {
      for (const e of result.errors) console.error(`emit: ${e}`);
      console.error(`\n${usage()}`);
      process.exit(1);
    }
    console.log(`persisted ${result.candidate.id} -> ${result.queueFile}`);
    console.log(`forge_candidate event: ${result.eventResult}`);
    process.exit(result.eventResult.startsWith('FAILED') ? 3 : 0);
  } else if (cmd === 'queue') {
    const queue = buildQueue({ eventsRoot, runsDir, since: opts.since });
    if (opts.format === 'json') {
      console.log(JSON.stringify(queue, null, 2));
    } else {
      process.stdout.write(renderQueueMd(queue));
    }
    // Build-read path (default window, no --since override): persist a
    // build-START snapshot so a subsequent `consume` archives EXACTLY this set
    // and advances the watermark to THIS read's moment — closing the
    // build/consume TOCTOU. A `--since` query is explicit inspection, not a
    // build read, so it must NOT overwrite the snapshot.
    if (!opts.since) {
      const candidates = [
        ...queue.groups['create-new'],
        ...queue.groups['edit-existing'],
        ...queue.groups['needs-verdict'],
      ];
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(
        snapshotPath(runsDir),
        // build_start_ts = the SAME pre-read cutoff buildQueue used for its
        // event upper-bound, NOT a fresh post-scan stamp — so consume's
        // watermark matches exactly the events this build read.
        `${JSON.stringify({ build_start_ts: queue.cutoffTs, candidates })}\n`,
        'utf-8',
      );
    }
  } else if (cmd === 'consume') {
    const result = consumeQueue({ runsDir, eventsRoot, buildId: opts.buildId });
    if (!result.ok) {
      for (const e of result.errors) console.error(`consume: ${e}`);
      process.exit(1);
    }
    console.log(`archived ${result.consumed} candidate(s) -> ${result.archivePath}`);
  } else {
    console.error(usage());
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
