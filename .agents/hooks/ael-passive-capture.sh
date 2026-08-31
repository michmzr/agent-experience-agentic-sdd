#!/bin/sh

source_name="$1"
repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cli="/Users/michmzr/projects/agent-experience-agentic-sdd/dist/src/cli.js"

if [ ! -f "$cli" ]; then
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
fi

node_is_compatible() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 17) ? 0 : 1)' >/dev/null 2>&1
}

node_command=$(command -v node 2>/dev/null || true)
if [ -n "$node_command" ] && ! node_is_compatible "$node_command"; then
  node_command=
fi
if [ -z "$node_command" ]; then
  for candidate in \
    "${NVM_BIN:-}/node" \
    "${VOLTA_HOME:-}/bin/node" \
    "${HOME:-}/.knode/bin/node" \
    "${HOME:-}/.volta/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    if [ -x "$candidate" ] && node_is_compatible "$candidate"; then
      node_command="$candidate"
      break
    fi
  done
fi
if [ -z "$node_command" ]; then
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
fi

"$node_command" "$cli" capture hook --source "$source_name" || {
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
}

exit 0
