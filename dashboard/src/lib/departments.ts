// Department layer for the cockpit. Maps a human department to the agent that
// runs it (by systemName / filesystem key). Plain data — no React imports — so
// it is safe to consume from both server components and the client sidebar.
//
// Maps each department to the real agent that runs it (by filesystem key).
// The department view handles a missing agent gracefully.

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
  { slug: 'operations',  label: 'Operations',  agent: 'chief',                       blurb: 'Orchestration, scheduling, and fleet coordination' },
  { slug: 'maintenance', label: 'Maintenance', agent: 'maintenance-coordinator',     blurb: 'Work orders, vendor dispatch, and turnovers' },
  { slug: 'leasing',     label: 'Leasing',     agent: 'leasing-coordinator',         blurb: 'Renewals, applicant screening, and showings' },
  { slug: 'analytics',   label: 'Analytics',   agent: 'scout',                       blurb: 'Reporting, KPIs, and portfolio insight' },
  { slug: 'dev',         label: 'Dev',         agent: 'claudia',                     blurb: 'Integrations, automation, and the technical stack' },
  { slug: 'accounting',  label: 'Accounting',  agent: 'agent-accounting-coordinator', blurb: 'AR/AP, owner draws, and trust reconciliation' },
];

export function getDepartment(slug: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.slug === slug);
}

export function departmentForAgent(agent: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.agent === agent);
}
