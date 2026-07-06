---
id: talk-to-eidan
title: Talk to eidan
---

# Talk to eidan

One agent, one memory — reached from wherever you are. Everything you say on any surface lands in the
same relational memory, so a note you drop on Telegram is there when you open the web app.

## Web chat

The reference web app is the full surface: streaming conversations, folders to organise threads, a
context-window meter, a per-response model/token line, and a model picker to switch models per chat.

{/* TODO(screenshot): the web chat — conversation + sidebar + the per-response model line. */}

## Telegram

Link your Telegram account and chat with your agent from your pocket — **text or voice**. Voice notes
are transcribed on the way in, so a spoken note becomes a normal message the agent acts on. Telegram
is a first-class input, not a bridge.

## Voice

Speak instead of type: the 🎙 button in web chat and Telegram voice notes both run through a
Whisper-compatible endpoint you configure (`EIDAN_WHISPER_ENDPOINT`). Great for capturing a thought
while walking — see [Capture with the journal](/guides/capture-with-the-journal).

## Terminal

For hacking and headless use, the engine ships a terminal REPL — the same agent and memory, at the
command line.

## Nudges out

The agent reaches back out through **notifications** — routed to Slack or Telegram by topic — so an
agent that finds something, or needs a decision, can ping you without you watching a screen.
