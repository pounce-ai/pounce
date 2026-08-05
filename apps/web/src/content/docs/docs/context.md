---
title: Agent instructions
description: Read the CLAUDE.md and AGENTS.md files steering a project, and hand fixes to an agent.
---

`CLAUDE.md`, `AGENTS.md` — the files that tell your agents how to work in a
project. When an agent does something baffling, the answer is often sitting in
one of them.

Open any [Space](/docs/spaces) to read the ones in play for that project,
rendered as one document rather than a stack of per-file cards, because that's
how the agent sees it.

## Reading, not editing

These are read-only in the app, deliberately.

Editing a repo file from a phone means a change with no diff and no review,
landing outside git. So instead: highlight the passage that's wrong, say what's
wrong with it, and hand your notes to an agent as a new task. The edit arrives
as a commit like any other, with a diff you can read in
[Changes](/docs/changes).

It's the slower-looking path that turns out to be faster, because you don't
later find a mystery edit nobody can trace.

## Which directory

A project has one checkout and any number of worktrees, each with its own files
on disk — so "the project's `CLAUDE.md`" is really a question about a
directory. Pounce leads with the repository root, where the committed context
lives, and offers the worktrees as alternatives.

## No context yet

A project with no instructions at all gets an offer to create one. Pounce
suggests `CLAUDE.md`, since Claude Code is the default agent — both names are
conventions rather than standards, and the file is created through an agent, so
it lands in git properly.
