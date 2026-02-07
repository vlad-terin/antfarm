# Antfarm

Antfarm installs and runs multi-agent workflows for OpenClaw. It gives you a repeatable way to spin up a set of agents, keep their workspaces in sync, and track runs by task title.

**Why use Antfarm**
- Standardize how you run complex tasks with multiple agents.
- Keep agent workspaces bootstrapped with the right files and skills.
- Track workflow runs by task title so status is easy to query.
- Install workflows from local paths, GitHub repos, or raw workflow URLs.
- Cleanly uninstall everything when you want to start fresh.

## Setup

```bash
npm install
npm run build
```

## Quickstart

```bash
antfarm workflow install ./workflows/feature-dev
antfarm workflow run feature-dev "Ship the onboarding prompt"
antfarm workflow status "Ship the onboarding prompt"
```

## Workflow Sources

You can install workflows from:
- Local paths (directory containing `workflow.yml`)
- GitHub repos
- GitHub subdirectories
- Raw `workflow.yml` URLs

Examples:

```bash
antfarm workflow install ./workflows/feature-dev
antfarm workflow install https://github.com/acme/workflows/tree/main/feature-dev
antfarm workflow install https://raw.githubusercontent.com/acme/workflows/main/feature-dev/workflow.yml
```

## Commands

```bash
antfarm workflow install <url-or-path>
antfarm workflow update <workflow-id>
antfarm workflow update <workflow-id> <workflow-url>
antfarm workflow run <workflow-id> <task-title>
antfarm workflow status <task-title>
antfarm workflow uninstall <workflow-id>
antfarm workflow uninstall --all
```

## Uninstall Notes

`uninstall` removes the workflow directory, workflow workspaces, run records, and any agents that the workflow installed. It also removes the Antfarm guidance block from the main agent’s `AGENTS.md` and `TOOLS.md` unless you opt out via the installer API.

## Repository Layout

- `src/cli`: CLI entrypoint
- `src/installer`: installer, workflow fetcher, and run state
- `workflows/feature-dev`: sample workflow
- `skills/antfarm-workflows`: skill used by workflow agents
