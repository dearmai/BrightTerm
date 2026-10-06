#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ $(uname -s) != Linux ]] || ! command -v apt-get >/dev/null || ! command -v dpkg >/dev/null; then
  echo 'make install supports Ubuntu, Debian and HamoniKR (apt-get required).' >&2
  exit 1
fi

version=$(node -p 'require("./package.json").version')
arch=$(dpkg --print-architecture)
package="$PWD/dist/BrightTerm-${version}-linux-${arch}.deb"
if [[ ! -f "$package" ]]; then
  echo "Package not found: $package. Run make deb with Node.js matching the system architecture." >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  apt-get install --yes --reinstall "$package"
else
  sudo apt-get install --yes --reinstall "$package"
fi

echo 'BrightTerm installed. Launch it from the application menu or run brightterm.'
