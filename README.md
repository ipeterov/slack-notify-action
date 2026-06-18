# slack-notify-action

A GitHub Action that posts a live-updating Slack card showing the status of jobs
in the current workflow run.

One `notify` job runs in parallel with the rest of your pipeline. The action
polls the GitHub Actions API every few seconds, posts a single Slack message,
and updates it in place until every watched job reaches a terminal state. You do
**not** sprinkle notify steps through your pipeline and you do **not** thread a
message id between steps — the action owns the message lifecycle itself.

## Usage

Add a job to your workflow that runs in parallel with the others:

```yaml
jobs:
  notify-slack:
    name: Notify Slack
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    env:
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
    steps:
      - uses: ipeterov/slack-notify-action@v1
        with:
          channel_id: C0123456789
          jobs: |
            - linters
            - tests
            - build
            - deploy

  linters:
    # ...
  tests:
    # ...
  build:
    # ...
  deploy:
    # ...
```

The action polls the GitHub Actions API every few seconds and calls
`chat.update` on a single Slack message until every watched job reaches a
terminal state.

## Inputs

| Input          | Required | Description |
|----------------|----------|-------------|
| `channel_id`   | yes      | Slack channel ID (e.g. `C0123456789`). Channel **names** are not supported — see below. |
| `jobs`         | yes      | Job ids to watch, in the same form `needs:` accepts. Accepts a scalar, a flow list, or a block list. |
| `github-token` | no       | Token to read the run and its jobs. Defaults to `${{ github.token }}`, which only needs `actions: read`. |

The bot token is read from the **`SLACK_BOT_TOKEN` environment variable**, not an
input. Pass it via `env:` on the job (see the example above).

The `jobs` input takes any of these:

```yaml
jobs: linters
jobs: [linters, tests, deploy]
jobs: |
  - linters
  - tests
  - deploy
```

Job ids must match the YAML keys under `jobs:` in your workflow file — the same
strings you'd use in `needs:`.

## Slack setup

The action needs a Slack bot token (`xoxb-…`) with the **`chat:write`** scope —
nothing more. That single scope is a deliberate constraint: resolving a channel
*name* to an ID would require `channels:read`/`groups:read`, so this action only
accepts a channel **ID**.

To find a channel's ID, open the channel in Slack → channel name → **About** →
the ID (`C…`) is at the bottom.

### Troubleshooting: invite the bot to the channel

The most common silent failure is **forgetting to invite the bot to the target
channel**. `chat.postMessage` to a channel the bot hasn't joined fails with
`not_in_channel` even though everything else is configured correctly. In the
channel, run:

```
/invite @your-bot-name
```

The action surfaces Slack's `error` field (e.g. `not_in_channel`,
`channel_not_found`, `invalid_auth`) in the job log, since Slack returns HTTP
200 even on logical failures.

## Required GitHub permissions

The notify job needs:

- `actions: read` — to poll the run and its jobs.
- `contents: read` — to fetch the workflow file and map your `jobs:` ids to the
  API's display names.

The default `GITHUB_TOKEN` is sufficient.

## Reruns

The notify job exits non-zero if any watched job ends in `failure` or
`timed_out`. This makes "Re-run failed jobs" include the notifier alongside the
jobs you're re-running, so the card keeps updating on the new attempt.

Each attempt posts a new Slack message; from attempt 2 onward the title includes
`(attempt N)` so the cards are easy to tell apart.

## Matrix jobs

Matrix jobs and reusable-workflow jobs are collapsed into one row per job id,
with a `N/M done` summary. The card stays compact regardless of how many
combinations the matrix expands into.

## Card layout

The card adapts its job list to the number of watched jobs, picking the
clearest layout that fits Slack's block constraints (a section's `fields`
array caps at 10 entries):

- **Up to 5 jobs** — a two-column grid with the job name and its status/details
  in separate columns.
- **6 to 10 jobs** — a more compact two-column grid, one cell per job, so the
  whole list still fits a single block with no visual gap.
- **More than 10 jobs** — the compact grid continues across additional blocks.
  A faint gap appears between blocks at this size; it's the trade-off for
  keeping every job visible.

You don't configure this — it's chosen automatically from the `jobs:` count.

## Migrating from `ivelum/github-action-slack-notify-build`

This action is a **zero-setup credential swap** for existing ivelum users:

- **No Slack-admin changes.** Same `SLACK_BOT_TOKEN` secret, same `chat:write`
  scope. The token is still read from the `SLACK_BOT_TOKEN` environment
  variable.

What changes is the *workflow shape*, not the credentials:

- ivelum's action is a **per-step** notifier — you place N notify steps through
  your pipeline and thread a `message_id` between them. This action is **one
  parallel job** that watches `jobs:` and owns the message lifecycle. Replace
  those N steps with a single `notify-slack` job (see [Usage](#usage)).
- Provide the channel as a **`channel_id`** (e.g. `C0123456789`), not a channel
  name. This action requires only `chat:write` and so cannot resolve names.
- There is no `status`/`color`/`message_id` input — status is discovered from
  the GitHub API automatically.

## License

MIT
