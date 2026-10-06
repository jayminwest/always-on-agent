# Sourced by every bin/ script after it sets $kit (the kit's install dir).
# Defaults below; override any of them in ~/.config/always-on-agent/config.
: ${AGENT_CONFIG:=$HOME/.config/always-on-agent/config}
[[ -r $AGENT_CONFIG ]] && source "$AGENT_CONFIG"

: ${AGENT_NAME:=agent}                                   # herdr workspace label, Remote Control name
: ${AGENT_HOME:=$HOME/agent}                             # the session's cwd; holds CLAUDE.md + handoff.md
: ${AGENT_STATE:=$HOME/.local/state/always-on-agent}     # session-id, last-sweep, paused, ...
: ${AGENT_TICKS_DIR:=$AGENT_STATE/spool}                 # the durable prompt spool
: ${AGENT_LOGS:=$HOME/Library/Logs/always-on-agent}
: ${AGENT_PERMISSION_MODE:=auto}
: ${AGENT_REMOTE_CONTROL:=0}                             # 1 = pass --remote-control $AGENT_NAME
(( ${+AGENT_CLAUDE_ARGS} )) || AGENT_CLAUDE_ARGS=()      # extra claude flags, e.g. (--channels ...)
: ${CLAUDE_BIN:=$(command -v claude || print -r -- $HOME/.local/bin/claude)}
: ${HERDR_BIN:=$(command -v herdr || print -r -- $HOME/.local/bin/herdr)}
: ${BUN_BIN:=$(command -v bun || print -r -- $HOME/.bun/bin/bun)}

export AGENT_NAME AGENT_HOME AGENT_STATE AGENT_TICKS_DIR AGENT_LOGS
mkdir -p "$AGENT_STATE" "$AGENT_LOGS"
