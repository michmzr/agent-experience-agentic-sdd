#!/bin/sh

source_name="$1"
repository_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cli="$repository_root/dist/src/cli.js"

if [ ! -f "$cli" ]; then
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
fi

node "$cli" capture hook --source "$source_name" || {
  printf '%s\n' 'AEL_CAPTURE_UNAVAILABLE: Passive capture skipped.' >&2
  exit 0
}

exit 0
