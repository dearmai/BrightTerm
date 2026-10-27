#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ $(uname -s) != Darwin ]]; then
  echo 'This installer requires macOS.' >&2
  exit 1
fi

arch=$(node -p 'process.arch')
case "$arch" in
  arm64) app="$PWD/dist/mac-arm64/BrightTerm.app" ;;
  x64) app="$PWD/dist/mac/BrightTerm.app" ;;
  *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac

if [[ ! -d "$app" ]]; then
  echo "Application not found: $app. Run make build first." >&2
  exit 1
fi

install_dir=${1:-/Applications}
mkdir -p -- "$install_dir" 2>/dev/null || sudo mkdir -p -- "$install_dir"
install_dir=$(cd -- "$install_dir" && pwd -P)
destination="$install_dir/BrightTerm.app"
if [[ "$destination" == "$app" ]]; then
  echo 'The installation directory must differ from the build directory.' >&2
  exit 1
fi

# Replace the bundle so files removed from a newer build do not linger.
# Only the installation step needs administrator privileges, when required.
if [[ -w "$install_dir" && ( ! -e "$destination" || -w "$destination" ) ]]; then
  rm -rf -- "$destination"
  ditto "$app" "$destination"
else
  sudo rm -rf -- "$destination"
  sudo ditto "$app" "$destination"
fi

echo "BrightTerm installed at $destination. Open it from Finder or run:"
printf 'open "%s"\n' "$destination"
