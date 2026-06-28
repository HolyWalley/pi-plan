# pi-plan

Project-local planning and sequential subagent execution workflow for [Pi](https://pi.dev).

## What it adds

Commands:

- `/plan <goal>` - start read-only planning mode for a project goal
- `/plan-status` - show active plan metadata and task status
- `/plan-review` - reopen Revdiff review for the latest draft
- `/plan-execute` - start sequential execution for an approved plan
- `/plan-exit` - leave plan/execution mode and restore normal tools without changing plan metadata
- `/plan-abort` - abort an active unapproved planning draft and restore normal tools

Tools:

- `plan_ask_user`
- `plan_submit_draft`
- `plan_get_status`
- `plan_start_task`
- `plan_record_task_result`
- `subagent`

Plan artifacts are stored per project under:

```text
.pi/plans/
```

The extension prompts to add `.pi/plans/` to the project `.gitignore`.

## Install globally

From this directory:

```bash
pi install /Users/yakau/Projects/pi-plan
```

Or after pushing to a git remote:

```bash
pi install git:git@github.com:<user>/pi-plan
```

## Requirements

- `revdiff` available on PATH for plan review
- Pi project trust enabled for projects where you want `.pi/plans/` state

## Subagents

Bundled agents live in `agents/` and are used by the `subagent` tool with:

```json
{
  "agentScope": "package"
}
```

Default bundled agents:

- `scout`
- `planner`
- `worker`
- `reviewer`

Plans remain project-local even though the extension is installed globally.
