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

Plan artifacts are stored per project under:

```text
.pi/plans/
```

The extension prompts to add `.pi/plans/` to the project `.gitignore`.

## Requirements

- `revdiff` available on PATH for plan review
- [`pi-subagents`](https://pi.dev/packages/pi-subagents?name=subagents) installed for delegated execution:

```bash
pi install npm:pi-subagents
```

- Optional but recommended: [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system). `pi-subagents` integrates with it so child permission prompts can be forwarded to the parent Pi UI.

## Install globally

```bash
pi install git:git@github.com:HolyWalley/pi-plan.git
```

For local development from this directory:

```bash
pi install /Users/yakau/Projects/pi-plan
```

Do not install both the local path and git package at the same time; their tools will conflict.

## Subagent model config

`pi-plan` delegates execution to `pi-subagents`. Configure subagent models in Pi settings, not in this repo.

User-global config:

```text
~/.pi/agent/settings.json
```

Project config:

```text
.pi/settings.json
```

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "model": "openai/gpt-5.5", "thinking": "low" },
      "worker": { "model": "openai/gpt-5.5", "thinking": "medium" },
      "reviewer": { "model": "openai/gpt-5.5", "thinking": "high" },
      "planner": { "model": "openai/gpt-5.5", "thinking": "xhigh" }
    }
  }
}
```

Run this inside Pi to inspect the live mapping:

```text
/subagents-models
```

Plans remain project-local even though the extension is installed globally.
