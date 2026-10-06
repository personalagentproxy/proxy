---
name: reviewing-pr-feedback
description: Interactively reviews code review comments on the current branch's pull request. Analyzes each thread, proposes solution options, and waits for the user to pick before acting. Use when you want to stay in control of how PR feedback is addressed.
---

# Reviewing PR Feedback

Interactive mode — analyze feedback, propose options, let the user decide.

## Prerequisites

1. Verify the current branch has an open pull request. If not, abort and notify the user.

```bash
gh pr view --json number,url,state
```

## Workflow

### 1. Fetch review threads

Get all unresolved review threads with their comments:

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            nodes {
              id
              body
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}' -f owner='{owner}' -f repo='{repo}' -F pr=<PR_NUMBER>
```

### 2. Walk through each thread

For each unresolved thread, understand the context, think about possible solutions, then propose them to the user.

Once the plan/response has been worked out with the user proceed.

### 4. Reply to a comment (when disagreeing)

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies \
  -f body='<Your response>'
```

### 5. Resolve a thread (after fixing)

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { isResolved }
  }
}' -f threadId='<THREAD_NODE_ID>'
```

### 6. Commit and push

After all threads are handled, commit and push:

1. Stage and commit changes with a message like: "address pr feedback"
2. Push to the remote branch

```bash
git push
```
