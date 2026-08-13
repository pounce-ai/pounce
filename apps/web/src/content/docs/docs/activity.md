---
title: Activity
description: What you've been building — across every agent and every machine you've paired.
---

Your agents each keep their own history, in their own format, on whichever
machine you ran them. **Activity** reads all of it and shows the whole picture
in one place.

## The year

A heatmap of every day you worked, across every paired machine. Tap a day for
its detail.

Underneath: headline numbers for the period you pick, how long your current
streak is, a trend line, and a split by agent — who did the work, Claude Code
or Codex or Cursor or opencode.

Any stat opens onto its own page, with week, month and year trends and
breakdowns by agent, by model, and by Space.

The whole screen shares as an image, if you want to post it.

## Cost

Pounce reports **what your agents actually reported**, not an estimate.

That's a deliberate limit. Agents differ in what they'll tell you: some report
dollars for every session, some report nothing because you're on a flat-rate
plan where per-session dollars would be fiction, and some report usage against
a rate limit instead. Pounce shows each of those as what it is.

So a small-looking number next to a busy project usually means _not
attributable_ rather than _free_. Where a total is an estimate rather than a
figure an agent reported, it's labelled as one.

Per-machine totals and per-project totals answer different questions and don't
always reconcile — an org billing total can't be split across the projects it
paid for.

## Disk

Agents working in parallel cut git worktrees, and nothing cuts them back. The
**Worktree disk** tile totals what they're holding across every paired machine;
opening it breaks that down by agent and lists every worktree, biggest first.

Each row says what deleting it would cost — how long it's been idle, how many
files are uncommitted, and how many commits exist on no remote. Anything idle
for ten days with nothing uncommitted is marked **clearable**.

Deleting removes the folder and keeps the branch, unless you choose _Delete
branch too_. If a worktree has uncommitted changes the machine refuses the
first time and offers you the thread that made them, so the choice is finish
the work or knowingly throw it away — never a folder that quietly vanishes with
your changes in it.

Only worktrees are listed. The checkouts you work in yourself are never shown
and can't be deleted from here.

## Per project

Every [Space](/docs/spaces) carries the same numbers folded over just that
project's sessions, so you can see what one repository has cost without
untangling it from everything else on the machine.

There's no year heatmap there, on purpose: a 53-week grid measures how
consistent _you_ are, which is a fair question about you and the wrong one
about a project. Projects get worked in bursts and then go quiet.

## Search

Everything Activity counts is also searchable — see [Search](/docs/search).
