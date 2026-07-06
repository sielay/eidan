---
id: concepts
title: Concepts
sidebar_position: 4
---

# Concepts

The ideas that make eidan a *finished agent* rather than a framework. eidan is built as **plugins
on the [matbot](https://github.com/MatAtBread/matbot) runtime** — a thin, isomorphic-TypeScript
agent engine — and adds the product layer: relational memory, interop, jobs, auth, and deploy.
**Postgres (the `eidan` schema) is the source of truth.**

## Relational memory

Memory isn't a text file or a vector blob — it's a **relational Postgres knowledge graph**.
Conversations, messages, events, knowledge, notes, decisions, jobs and artifacts are rows you can
query, link, export, and back up. Persistence is **keen**: an inbound message hits the store
*before* the model is called, and messages are append-only. Knowledge is Obsidian-style linked, not
flat, so loading it is about relationships, not string search alone.

## Plugins & the service model

A plugin is one TypeScript module exporting `const plugin`. It extends the host through matbot's
seams — **tools**, **hooks** (screen / contribute / toolcall / toolresult / followup), a
**StorageBackend** / **KnowledgeIndex**, **providers**, **frontends**, and a **service registry**.
Cross-plugin collaboration goes through the registry keyed by interface name (e.g. `EidanMemory`,
`JobHandlers`, `Notify`), so bundles compose without hard dependencies. A plugin can ship a whole
vertical feature — backend, data schema, behaviours, an admin screen — in one folder.

## Agents & triggers

Beyond the default assistant, you define **your own agents**: each a persona, its own model, and
one or more **triggers** — a schedule, a sensor, a webhook. Agents run under your identity with
your tools, can relate to each other (delegate down, escalate up), and record every run so their
activity is observable.

## Jobs & delegation

Work you hand off lands on the **`eidan.jobs`** work-queue, routed by *capability kind* rather than
by machine. A node that serves that kind claims it, runs it, and reports back. This is how a chat
request to "fix this bug" becomes a background coding job the Sage bundle picks up and turns into a
pull request.

## The vault

Third-party credentials live in a **per-user encrypted vault** (envelope-encrypted at rest, master
key in the environment only). The agent uses them **by reference** — a key is never pasted into a
prompt or handed to a model. A separate LLM-free write path lets a settings UI store secrets
without the model ever seeing the value.

## Interop — MCP, A2A, AG-UI

eidan speaks three open protocols on three boundaries: **MCP** (expose its tools to external agents,
and call external MCP tools), **A2A** (other agents can delegate to it), and **AG-UI** (the wire
between the agent and the web chat). Interop is in and out, so eidan plugs into an existing stack
rather than replacing it.

## Runs anywhere, multi-node

eidan runs on one node or many — a laptop, a Raspberry Pi, a Fly app — **all sharing one Postgres**.
Concurrency and single-owner work (schedules, queues) are coordinated through the shared database,
so you can scale out horizontally without a second source of truth.

---

Ready to try it? Head to **[Getting started](/getting-started)**, or browse **[Use cases](/use-cases)**.
