# SOPs — Standard Operating Procedure templates

This directory holds 46 ready-to-use property-management workflow templates as plain
JSON files. They are **for your agents to read, run, and edit directly** — there is no
app, backend, or database required. A SOP is just a file: point one of your agents at it,
or tell your agent how you handle a workflow and let it edit the file.

`index.json` is the catalog (slug, name, subject type, stage/task counts).

## What a SOP looks like

Each `<slug>.json` is one workflow:

```jsonc
{
  "slug": "late-rent-copilot",
  "name": "Late Rent Copilot",
  "description": "Draft late-rent reminders from delinquency data, with approval before any resident send.",
  "subject_type": "delinquency_batch",     // what the workflow operates on
  "default_start_stage_key": "import",
  "stages": [                               // ordered phases
    {
      "stage_key": "import",
      "name": "Import Delinquency Data",
      "description": "...",
      "steps": [                            // the actual tasks
        {
          "task_key": "parse_report",
          "title": "Parse delinquency report",
          "kind": "agent_task",            // see "Step kinds" below
          "assigned_role": "accounting",   // which role does it — map to YOUR agent
          "instructions": "Read the delinquency export and extract...",
          "depends_on": [],                 // task_keys that must finish first
          "is_automated": true,
          "human_prompt": null,             // question to ask a human, if any
          "dispatch_title": null,           // outbound message title, if any
          "dispatch_body": null,
          "estimated_minutes": 5
        }
      ]
    }
  ]
}
```

### Step kinds
- `agent_task` — an agent does this step (follow `instructions`).
- `human_review` — a human looks before proceeding. **Treat as an approval gate.**
- `human_approval` — a human must approve before the next step. **Treat as an approval gate** (stop and ask; do not proceed until approved).
- `system_handoff` — hand the work to another role/system.

### assigned_role
A generic role: `operations`, `maintenance`, `leasing`, `accounting`, plus `human`,
`pm`, `owner`. **These are roles, not agent names — map each to whichever of your own
agents handles that domain.** (For example, if your maintenance agent is named "max",
`maintenance` steps go to max.)

## How your agent RUNS a SOP

Tell your agent, e.g. "run the late-rent-copilot SOP":

1. Read `sops/late-rent-copilot.json`.
2. Work the `stages` in order; within a stage, respect each step's `depends_on`.
3. For `agent_task` steps, follow `instructions` (the role in `assigned_role` maps to one of your agents).
4. For `human_review` / `human_approval` steps, **stop and get the human's OK before continuing** — never auto-proceed through a gate.
5. Use `dispatch_title` / `dispatch_body` when a step sends an outbound message, and `human_prompt` when it asks a person a question.

The JSON is self-describing — an agent can parse and follow it with no extra tooling.

## How to EDIT or CREATE one (fit it to your shop)

A SOP is a file, so tailoring it is a normal file edit:

- **Adapt a template:** copy `sops/<slug>.json`, change the `instructions`,
  `assigned_role`, gates, or steps to match your PMS and process, save it. Tell your
  agent "I handle late rent like this instead ..." and let it edit the file.
- **Create a new one:** copy the closest template, give it a new `slug`/`name`, and edit
  the stages/steps. Keep the shape above (stages → steps, with `kind` + `assigned_role`).
- **Keep human gates honest:** anything money-, legal-, or resident-facing should stay a
  `human_approval` step so a person signs off before it goes out.

That's it — no build step, no server. Edit the file, and your agents pick up the change
the next time they read it.
