---
name: creating-pr
description: Creates a GitHub pull request from the current feature branch. Use when the user wants to submit their changes for review.
---

# Creating a Pull Request

## General

Commit messages and PR titles start with lowercase

## Prerequisites

1. Verify you're on a feature branch (not `main` or `master`). If not, abort and notify the user.
2. If uncommitted changes exist, commit them with a fitting message. Don't give Claude or Codex attribution.
3. Push the branch to origin.

## Workflow

1. Review the diff using `mcp__conductor__GetWorkspaceDiff`
2. Create the PR:

```bash
gh pr create --base main --title "<title>" --body "<description>"
```

## PR Guidelines

**Title**: Under 80 characters, imperative mood (e.g., "Add user authentication")

**Description**: 2-5 sentences covering:

- What changed
- Why it changed
- Any notable implementation details

If any step fails, ask the user for help.
