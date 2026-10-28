#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

for SIZE in 80 130; do
  inkscape assets/icon.svg --export-type=png --export-filename=assets/icon${SIZE}.png -w ${SIZE} -h ${SIZE}
done

echo "Icons generated: assets/icon80.png (80x80), assets/icon130.png (130x130)"
