import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const AGENT_REGEX = /^[a-z0-9_-]+$/;

// Mirror of /api/skills parseSkillMd — pull name + description from a SKILL.md
// frontmatter, falling back to the first markdown H1 for name.
function parseSkillMd(content: string): { name: string; description: string } {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = '';
  let description = '';
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const nm = fm.match(/^name:\s*(.+)$/m);
    const dm = fm.match(/^description:\s*(.+)$/m);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '');
  }
  if (!name) {
    const h = content.match(/^#\s+(.+)$/m);
    if (h) name = h[1].trim();
  }
  return { name, description };
}

// Source of truth for an agent's actual loaded skills is .claude/skills/ — each
// entry is a skill directory (or symlink to one) containing a SKILL.md. This is
// distinct from the dashboard's catalog-install model (orgs/.../skills/), which
// is unused fleet-wide. This route is READ-ONLY (display); enable/disable +
// attach-from-catalog are a deferred fast-follow pending the write mechanism.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const org = request.nextUrl.searchParams.get('org') || '';

  if (!AGENT_REGEX.test(name) || !org || !AGENT_REGEX.test(org)) {
    return Response.json({ error: 'Invalid agent or org' }, { status: 400 });
  }

  try {
    const frameworkRoot = getFrameworkRoot();
    const skillsDir = path.join(frameworkRoot, 'orgs', org, 'agents', name, '.claude', 'skills');

    if (!fs.existsSync(skillsDir)) {
      return Response.json({ skills: [] });
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const skills: Array<{ slug: string; name: string; description: string }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // Accept directories and symlinks-to-directories; the test is whether a
      // SKILL.md exists inside.
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      let content = '';
      try {
        content = fs.readFileSync(skillMd, 'utf-8');
      } catch {
        continue;
      }
      const { name: skillName, description } = parseSkillMd(content);
      skills.push({
        slug: entry.name,
        name: skillName || entry.name,
        description,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ skills });
  } catch (err) {
    console.error('[api/agents/[name]/skills] error:', err);
    return Response.json({ error: 'Failed to read agent skills' }, { status: 500 });
  }
}
