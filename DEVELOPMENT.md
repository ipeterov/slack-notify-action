# Development

This document is for maintainers of `slack-notify-action`.

## Releasing a new version

Releases are automated. To publish a new version:

1. Bump `version` in `package.json` (e.g., `1.0.0` → `1.0.1` or `1.1.0`).
2. Run `npm run build` and commit `dist/index.js`.
3. Push to `main`.

The release workflow will:

- Check whether the tag `v<version>` already exists.
- If not, create it and a matching GitHub Release.
- Fast-forward the floating major tag (`v1`, `v2`, …) so callers using
  `@v1` get the latest within the major.

The version in `package.json` is the single source of truth. No manual
`git tag` or `gh release` is needed.

## Local development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Build `dist/index.js`:

```bash
npm run build
```

`dist/index.js` is checked in. CI fails if it's out of date with `src/`, so
remember to rebuild and commit after changing source files.

## End-to-end test against a real run

```bash
GITHUB_REPOSITORY=<owner/repo> \
GITHUB_RUN_ID=<numeric-run-id> \
GITHUB_TOKEN= \
SLACK_BOT_TOKEN=xoxb-... \
INPUT_CHANNEL_ID=C0123456789 \
INPUT_JOBS=$'- job-id-1\n- job-id-2' \
node dist/index.js
```

The bot token is read from `SLACK_BOT_TOKEN` (an environment variable), not an
input — mirroring how the action is invoked in CI. The bot must be invited to
the target channel, or `chat.postMessage` fails with `not_in_channel`.

Use a completed run for a one-shot post; use an in-progress run to watch the
polling loop update the card live.
