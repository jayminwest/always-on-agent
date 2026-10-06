#!/bin/zsh
# install.sh: install the kit for the current user. Safe to re-run.
#   - copies bin/, lib/, plugin/, templates/ to $AGENT_KIT
#     (default ~/.local/share/always-on-agent) and links bin/agent-* into ~/.local/bin
#   - creates ~/.config/always-on-agent/config and $AGENT_HOME/CLAUDE.md if missing
#   - renders the launchd plists into ~/Library/LaunchAgents (does NOT load them)
# macOS only. Linux/systemd: TODO (see README).
emulate -L zsh
set -e
src=${0:A:h}
[[ $(uname) == Darwin ]] || { print -u2 "macOS only for now (Linux/systemd is a TODO)."; exit 1; }

for dep in claude herdr bun jq; do
  command -v $dep >/dev/null || print -u2 "warning: '$dep' not found on PATH"
done

kit=${AGENT_KIT:-$HOME/.local/share/always-on-agent}
cfgdir=$HOME/.config/always-on-agent
bindir=$HOME/.local/bin
agents=$HOME/Library/LaunchAgents

# 1. Kit: replace wholesale so removed files don't linger.
mkdir -p ${kit:h} $bindir $cfgdir $agents
rm -rf $kit.new
mkdir $kit.new
cp -R $src/bin $src/lib $src/plugin $src/templates $kit.new/
rm -rf $kit
mv $kit.new $kit
for f in $kit/bin/agent-*; do ln -sfn $f $bindir/${f:t}; done
print "kit:      $kit (linked into $bindir)"

# 2. Config (kept if present).
[[ -e $cfgdir/config ]] || cp $src/config.example $cfgdir/config
print "config:   $cfgdir/config"

# Read the resulting settings the same way the scripts do.
source $kit/lib/env.zsh

# 3. Agent home + standing rules (kept if present).
mkdir -p $AGENT_HOME
[[ -e $AGENT_HOME/CLAUDE.md ]] || cp $kit/templates/CLAUDE.md $AGENT_HOME/CLAUDE.md
print "home:     $AGENT_HOME (CLAUDE.md)"

# 4. launchd plists.
path_env="$bindir:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
labels=()
for t in $src/launchd/*.plist.template; do
  name=${${t:t}%.plist.template}
  label=local.always-on-agent.$name
  sed -e "s|__KIT__|$kit|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$path_env|g" \
      -e "s|__LOGS__|$AGENT_LOGS|g" $t > $agents/$label.plist
  plutil -lint -s $agents/$label.plist
  labels+=($label)
done
print "launchd:  ${labels[*]} in $agents (not loaded)"

cat <<EOF

Next steps:
  1. Trust the agent's directory once:   cd $AGENT_HOME && claude   (accept, then /exit)
  2. Edit $AGENT_HOME/CLAUDE.md to taste.
  3. Load the launchd jobs (re-run bootout first when updating):
EOF
for l in $labels; do
  print "       launchctl bootout gui/\$(id -u)/$l 2>/dev/null; launchctl bootstrap gui/\$(id -u) $agents/$l.plist"
done
cat <<EOF
  4. Watch it come up:                   herdr   (workspace "$AGENT_NAME")
  5. Smoke test:                         agent-remind "in 2m" "test reminder"
                                         agent-tick day-start
                                         agent-rotate --dry-run
  Pause: touch $AGENT_STATE/paused       Logs: $AGENT_LOGS
EOF
