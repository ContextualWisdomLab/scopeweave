#!/usr/bin/env bash
set -euo pipefail

event_name="${1:-}"
requested_runs="${2:-}"
default_runs=20000
max_runs=200000

if [[ "$event_name" == "schedule" ]]; then
  runs="$max_runs"
elif [[ "$requested_runs" =~ ^[1-9][0-9]{0,5}$ ]] && (( 10#$requested_runs <= max_runs )); then
  runs="$((10#$requested_runs))"
else
  runs="$default_runs"
fi

printf '%s\n' "$runs"
