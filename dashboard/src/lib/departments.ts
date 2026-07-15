// Department layer for the cockpit. Maps a human department to the agent that
// runs it (by systemName / filesystem key). Plain data — no React imports — so
// it is safe to consume from both server components and the client sidebar.
//
// Mirrors orgs/ascendops/agents/dane/deliverables/cockpit-dashboard-scope-2026-06-25.html
// (Operations→dane, Maintenance→blue, Leasing→lacey, Analytics→aussie,
// Dev→collie, Accounting→cash). Accounting (cash) may not be stood up yet —
// the department view handles a missing agent gracefully.

export interface Department {
  /** URL slug: /departments/<slug> */
  slug: string;
  /** Display label */
  label: string;
  /** The agent's systemName (filesystem key) that runs this department */
  agent: string;
  /** One-line description of what this department covers */
  blurb: string;
}

export const DEPARTMENTS: Department[] = [
  { slug: 'operations',  label: 'Operations',  agent: 'dane',   blurb: 'Orchestration, scheduling, and fleet coordination' },
  { slug: 'maintenance', label: 'Maintenance', agent: 'blue',   blurb: 'Work orders, vendor dispatch, and turnovers' },
  { slug: 'leasing',     label: 'Leasing',     agent: 'lacey',  blurb: 'Renewals, applicant screening, and showings' },
  { slug: 'analytics',   label: 'Analytics',   agent: 'aussie', blurb: 'Reporting, KPIs, and portfolio insight' },
  { slug: 'dev',         label: 'Dev',         agent: 'collie', blurb: 'Integrations, automation, and the technical stack' },
  { slug: 'accounting',  label: 'Accounting',  agent: 'cash',   blurb: 'AR/AP, owner draws, and trust reconciliation' },
];

export function getDepartment(slug: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.slug === slug);
}

export function departmentForAgent(agent: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.agent === agent);
}
