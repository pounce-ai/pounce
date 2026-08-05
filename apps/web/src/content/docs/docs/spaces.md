---
title: Spaces
description: A Space is one project on one machine — the unit Pounce organises everything around.
---

A **Space** is one project on one machine.

That second half matters. The same repository checked out on your laptop and on
a build box are two different places to work: different files on disk,
different branches, different agents running right now. Pounce keeps them
apart, even though they share a name.

Nothing creates a Space. They're derived from the sessions that exist — start
an agent in a folder and that folder is a Space from then on.

## Worktrees belong to their project

If you use git worktrees — by hand, or through a tool that makes them for you —
every worktree groups under the project it was cut from. One row for the
project, not one per branch.

Pounce works this out by asking git, not by reading the path. A worktree's
layout is a convention that differs per tool, but git records where each one
came from, on the repository's side. That record outlives the worktree
directory, so a branch you merged and deleted months ago still sits under the
right project instead of drifting off as its own entry.

Where a directory can't be traced to any project — a copy with no git history,
say — it keeps its own folder name rather than being lumped in with other
strays.

## What a Space shows you

Open one and you get the project rather than the thread:

- **What it cost** — tokens and, where an agent reports them, dollars, folded
  over just this project's sessions. A quiet number means "not attributable",
  never "nothing happened". See [Activity](/docs/activity).
- **What it tells your agents** — the `CLAUDE.md` and `AGENTS.md` files in play
  for this project. See [Agent instructions](/docs/context).
- **Its sessions** — everything worked on here, across every agent.

## Filtering by Space

The filter sheet on Home lists every Space you've synced. Use it to narrow to
one project, or hide a folder you don't want cluttering the list — scratch
directories and one-off experiments earn their place there quickly.

Filters also cover status, agent, device, and branch or worktree, and they
stack.

## Devices, and one machine appearing twice

A Space belongs to a machine, so Pounce has to know which machine is which.
That identity comes from the machine itself — not from the address your phone
happened to reach it at.

The distinction is easy to miss until it bites. One computer is
`192.168.1.4` on your home network, something else entirely on a café's wifi,
and different again after your router hands out a new lease. Identifying it by
address would file the same machine under a new name each time, and split its
history across the copies.

So if you pair a machine you already have — new address, new port, whatever —
Pounce recognises it and updates the machine you know, rather than adding
another one beside it.
