# always-on-agent

How I run an always-on Claude Code agent on a Mac, with herdr and launchd.

This is my setup, not a product. It is opinionated (macOS, herdr, launchd,
zsh, bun) and small on purpose: five scripts, one plugin, three plists and a
CLAUDE.md. Copy what's useful.

## What it does

One Claude Code session stays up all day in a herdr pane. It's one long
conversation: crash it or `/exit` it and it comes back with the same session.
launchd wakes it on a schedule (a morning start, hourly heartbeats) and I can
queue reminders for it. Every prompt goes through a small on-disk spool, so
nothing is lost while the session is busy, restarting, or the laptop is
asleep. Once a day it writes a handoff note and starts a fresh session, so
context doesn't grow forever.

## How it fits together

```
launchd ──(every 2 min)──> agent-ensure ──> herdr workspace ──> agent-loop ──> claude (one session)
launchd ──(06:00, hourly)─> agent-tick <tag> ─┐                                     ▲
you / the agent ─────────> agent-remind ──────┴─> spool (~/.local/state/.../spool)  │
                                                      └── agent-ticks plugin ───────┘
                                                          (delivers when idle)
day-start: agent writes handoff.md ─> agent-rotate --brief ─> loop starts a fresh session ─> [morning-brief]
```

- `agent-loop` runs `claude` in `$AGENT_HOME` and restarts it 10s after it
  exits, resuming the saved session id.
- `agent-ensure` starts the herdr server if needed, opens a workspace, runs the
  loop there. Does nothing if the loop is already up or `paused` exists.
- `agent-tick <tag>` queues `[<tag>] since <last-sweep>`, deduped by tag.
- `agent-remind` queues one-shot reminders ("in 2h", "tomorrow 9am", ISO).
- `agent-rotate` clears the session id and kills only the loop's claude child.
- `plugin/` (agent-ticks) drains the spool into the session as one prompt
  whenever it's idle. Only the loop's session consumes (`AGENT_TICKS_CONSUMER=1`).
- `templates/CLAUDE.md` is the agent's standing rules: what each tick means,
  the sweep, the handoff format, when to escalate, and draft-don't-send.

## Requirements

macOS, [Claude Code](https://docs.claude.com/en/docs/claude-code) (logged in),
[herdr](https://herdr.dev), [bun](https://bun.sh) (spool CLI and plugin), `jq`, zsh.

## Quick start

```sh
git clone <this repo> && cd always-on-agent
./install.sh            # copies to ~/.local/share/always-on-agent, renders plists; loads nothing
cd ~/agent && claude    # trust the directory once, then /exit
$EDITOR ~/agent/CLAUDE.md
# then load the launchd jobs with the launchctl lines install.sh printed
herdr                   # the agent's workspace appears within ~2 min
```

Smoke test: `agent-remind "in 2m" "test"`, `agent-tick day-start`,
`agent-rotate --dry-run`, `agent-remind --list`. Inside the session, `/ticks`
shows the spool.

Settings live in `~/.config/always-on-agent/config` (see `config.example`): the
agent's directory, permission mode, Remote Control, extra `claude` flags. If
`~/.config/always-on-agent/settings.json` exists it's passed as `--settings`
(I put my permission allow list and hooks there).

Pause everything: `touch ~/.local/state/always-on-agent/paused`. Logs:
`~/Library/Logs/always-on-agent/`.

## Laptop vs. always-on server

On a server that never sleeps it just runs. On a laptop, the trick is launchd's
`StartCalendarInterval`: a job missed during sleep runs once on wake, and
several missed runs coalesce into one. So:

- `[day-start]` (06:00) lands on the first wake of the day.
- Missed heartbeats arrive as one `[heartbeat]`, and its `since <t>` stamp
  covers the whole gap, so the agent sweeps 14 hours the same way as 1.
- `[heartbeat]` is skipped until today's day-start has run (and for 15 min
  after), so the morning wake gives one prompt, not two.
- Reminders that came due during sleep are delivered on wake.
- A powered-off machine misses ticks; the next tick or login covers it.
- After a long sleep remote MCP servers may need `/mcp`; CLAUDE.md tells the
  agent to reconnect and retry once.

Heartbeats run every day 09:00-18:00; edit `launchd/heartbeat.plist.template`
for weekdays only or a different window.

## Talking to it

- **The herdr pane.** Attach with `herdr` and type.
- **Remote Control (optional).** Set `AGENT_REMOTE_CONTROL=1` to start the
  session with `--remote-control`, then reach it from claude.ai/code or the
  Claude mobile app.
- **iMessage channel plugin (optional).** I text mine through the official
  iMessage channel plugin: add it via `AGENT_CLAUDE_ARGS` and configure its
  allowlist. Note that it reads the Messages database, which needs Full Disk
  Access for whatever process starts the herdr server.

## Not done

- Linux/systemd: TODO. The same shape should work with a user service for
  `agent-ensure` and `OnCalendar=` timers with `Persistent=true` for the ticks
  (the systemd equivalent of catching up after sleep).
- No watchdog for a session stuck on a permission prompt.

## License

MIT. See `LICENSE`.
