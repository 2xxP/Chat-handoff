# chat-handoff

A Claude Code mod that stops chats getting too long. It shows how full the
chat is under the prompt, warns you when it passes a set point (60% by
default), and writes a handoff note you can paste into a new chat so the work
carries on without re-explaining everything.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install chat-handoff --marketplace 2xxP/chat-handoff
```

Answer `y` to add the marketplace, then press Enter to pick the user scope, so
it loads in every session on that computer.

From a shell:

```
claude plugin install chat-handoff --marketplace 2xxP/chat-handoff
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `2xxP/chat-handoff`, then Add plugin.

This repository is private: the computer installing it needs a git credential
for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Use

- `/handoff` writes the note now. Add words after it to stress something:
  `/handoff the login bug`.
- At the warning point a row above the prompt offers **Write handoff** or
  **Later**. The warning repeats every 10 points.
- Each note is shown in the chat and saved to `handoffs/` in the working folder.

## Settings

In `/config`: the warning percentage, whether to warn or write the note
automatically, the folder notes are saved to, and a list of things every note
must always cover.
