---
name: addressing-pr-feedback
description: Automatically addresses code review comments on the current branch's pull request. Use when you want the agent to fix issues and resolve threads autonomously without asking for approval on each change.
---

# Addressing PR Feedback

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

### 2. Process each unresolved thread

For each unresolved thread:

1. Read the comment body to understand the feedback
2. Read the relevant file and line to understand the context
3. Decide on action:

**If the feedback is valid and actionable:**

- Make the fix in the codebase
- After fixing, resolve the thread (see step 4)

**If you disagree or the feedback is not applicable:**

- Reply to the comment explaining why
- Do NOT resolve the thread (let the reviewer decide)

### 3. Reply to a comment (when disagreeing)

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies \
  -f body='<Your response explaining why you disagree or why the fix is not applicable>'
```

### 4. Resolve a thread (after fixing)

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { isResolved }
  }
}' -f threadId='<THREAD_NODE_ID>'
```

### 5. Commit and push

After addressing all feedback:

1. Stage and commit changes with a message like: "address pr feedback"
2. Push to the remote branch

```bash
git push
```
