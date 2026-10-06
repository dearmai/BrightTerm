#!/usr/bin/env bash
# Regenerate the committed Linux packaging sizes from the existing app icon.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if command -v magick >/dev/null; then
  converter=magick
elif command -v convert >/dev/null; then
  converter=convert
else
  echo 'Install ImageMagick to regenerate Linux icons.' >&2
  exit 1
fi
mkdir -p build/icons
for size in 16 24 32 48 64 128 256 512; do
  "$converter" build/icon.png -resize "${size}x${size}" "build/icons/${size}x${size}.png"
done
