---
title: Changes
description: Read the diff your agent produced, then commit, push, or open a PR — from your phone.
---

An agent says it's done. **Changes** is where you find out what it actually
did.

Open it from any session for the full diff of that working directory: files
changed, added, removed, with proper syntax highlighting rather than a wall of
grey. On the desktop app it docks beside the transcript, so you can read the
reasoning and the result together.

## Shipping it

Once the diff looks right:

- **Commit** — write a message, or leave it empty and let an agent write one
  from the diff.
- **Push** — to `origin`.
- **Commit & push** — both, in one go.
- **Create PR** — opens the pull request.

Committing straight onto `main` or `master` asks first. Not forbidden, just
confirmed — on a shared branch that's almost never what you meant, and it's an
easy thing to fire off one-handed.

## Reading a long diff

Very large diffs are truncated rather than choked on. If you need the whole
thing, it's on the machine where the work happened.

## When there's nothing to see

A session with no working-directory changes shows nothing here — the agent may
have only read files, or answered a question. Sessions whose worktree has since
been deleted keep their transcript, but there's no diff left to read.
