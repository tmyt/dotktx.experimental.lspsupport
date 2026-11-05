#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"
# The local feed must exist even on the first restore of a fresh checkout.
mkdir -p "$repo_dir/artifacts/packages"

dotnet pack "$repo_dir/src/DotKtX.Experimental.LspSupport/DotKtX.Experimental.LspSupport.csproj" \
  --configuration Release "$@"
