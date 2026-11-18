---
name: github
description: Manage GitHub from the terminal — list/create/comment on issues and pull requests, review PRs, cut releases, inspect repos, and search — using the gh CLI. Use when the user asks to open a PR, triage issues, review changes, check CI, or query anything on GitHub.
compatibility: Requires the gh CLI.
---

# GitHub (via the gh CLI)

Operate the user's GitHub through the official `gh` CLI over the bash tool. `gh`
authenticates once (`gh auth login`, stored in the OS keychain) and infers the
repo from the current directory's git remote — pass `--repo owner/name` to target
another repo.

## Prefer the harness's NATIVE GitHub surfaces first

Dimension's engine ships built-in GitHub support — use it BEFORE reaching for
`gh` via bash; it is cached (SQLite, auto-invalidated when a mutating `gh`
command runs) and cheaper:

- **Reading issues/PRs/diffs** → the `read` tool with internal URLs:
  `issue://42`, `pr://123`, `pr://123/diff` (and `pr://123/diff/<file>`)
  — never `gh issue view` / `gh pr view` / `gh pr diff` for a plain read.
- **Repo overview, searches, PR create/checkout/push, CI watch** → the native
  `github` tool (ops: `repo_view`, `pr_create`, `pr_checkout`, `pr_push`,
  `search_issues|prs|code|commits|repos`, `run_watch`) — never the equivalent
  `gh` porcelain via bash.

**This skill owns only what the native surfaces do NOT cover**: issue
create/comment/close, PR review (comment/approve/request-changes) and merge,
releases, and the `gh api` escape hatch. The command sections below for
reading/searching/creating PRs are the FALLBACK when the native tool is
unavailable (e.g. running under a plain OMP host without them registered).

## Setup

Confirm the CLI is present and authenticated:

```bash
gh --version
gh auth status          # verifies the stored token; the connector's verify command
```

If `gh auth status` reports "not logged in", the connector isn't set up — have the
user run `gh auth login` (GitHub.com → HTTPS → "Login with a web browser") or go
to **Plugins → GitHub → Set up**. Never ask the user to paste a token; `gh` owns
credential storage.

## Issues

```bash
gh issue list                                          # open issues, current repo
gh issue list --state all --limit 50 --label bug       # filter by state/label
gh issue list --assignee @me --json number,title,labels # machine-readable output
gh issue view 42                                        # full issue + comments
gh issue view 42 --comments                             # include the thread
gh issue create --title "Crash on save" --body "Steps..." --label bug
gh issue comment 42 --body "Confirmed on 1.2.0"
gh issue close 42 --reason completed                    # or --reason "not planned"
```

For a summary, prefer `--json` + `--jq` so you parse structured data rather than
scraping the table:

```bash
gh issue list --state open --json number,title,labels,createdAt \
  --jq 'group_by(.labels[].name)'
```

## Pull requests

```bash
gh pr list --state open                                 # open PRs
gh pr status                                            # PRs relevant to you + CI
gh pr view 123                                          # PR summary + checks
gh pr view 123 --json title,body,reviews,statusCheckRollup
gh pr checks 123                                         # CI status per check
gh pr diff 123                                           # the unified diff
gh pr checkout 123                                       # switch to the PR branch locally
```

Open a PR for the current branch (push first if needed):

```bash
gh pr create --base main --head "$(git branch --show-current)" \
  --title "Add rate limiter" --body "Closes #42. ..."
gh pr create --fill                                      # title/body from commits
gh pr create --draft                                     # open as draft
```

Review a PR — comment, approve, or request changes:

```bash
gh pr review 123 --comment --body "Left a few notes inline."
gh pr review 123 --approve
gh pr review 123 --request-changes --body "Please add a test for the empty case."
```

## Releases

```bash
gh release list                                         # existing releases/tags
gh release view v1.2.0                                   # notes + assets
gh release create v1.3.0 --generate-notes               # DESTRUCTIVE — confirm first
gh release create v1.3.0 ./dist/*.zip --title "1.3.0" --notes "..."
```

## Repo info & search

```bash
gh repo view                                            # current repo overview
gh repo view owner/name --json description,stargazerCount,defaultBranchRef
gh search issues "memory leak" --repo owner/name --state open
gh search prs "author:@me is:merged" --limit 20
gh search repos "topic:cli language:rust" --sort stars
```

## API escape hatch

Anything the porcelain commands don't cover — reach any REST or GraphQL endpoint:

```bash
gh api repos/owner/name/commits --jq '.[0].commit.message'
gh api /rate_limit                                       # check remaining quota
gh api graphql -f query='query { viewer { login } }'
gh api -X POST repos/owner/name/issues/42/labels -f labels[]=triage
```

## Safety

- NEVER run a mutating command — `gh issue/pr create`, `gh issue/pr comment`,
  `gh pr merge`, `gh pr close`, `gh release create`, `gh repo delete`, or any
  `gh api -X POST/PATCH/PUT/DELETE` — without explicit user confirmation of the
  target and content **in the current turn**. `gh pr merge`, `gh release create`,
  and `gh repo delete` are especially irreversible; always confirm.
- Read-only queries (`list`, `view`, `status`, `checks`, `diff`, `search`,
  `gh api` GETs) are safe to run unprompted.
- When drafting a PR body, issue, or comment, show the user the text before
  posting when intent is ambiguous.
- Quote exact numbers (issue/PR `#`, tag names, repo `owner/name`) in every
  summary so follow-up actions are unambiguous.
- Use `--repo owner/name` whenever the working directory isn't the intended repo.
- Prefer `--json <fields> --jq <filter>` for anything you parse — never scrape the
  human table when structured output exists.
