#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"
verification_dir="$repo_dir/artifacts/verification"
mkdir -p "$verification_dir"

run_logged() {
  local log="$1"
  shift
  if ! "$@" >"$log" 2>&1; then
    cat "$log" >&2
    return 1
  fi
}

run_logged "$verification_dir/pack.log" bash "$repo_dir/scripts/pack.sh" "$@"
cat "$verification_dir/pack.log"

properties="$(dotnet msbuild "$repo_dir/src/DotKtX.Experimental.LspSupport/DotKtX.Experimental.LspSupport.csproj" \
  -nologo -p:Configuration=Release "$@" -getProperty:TargetDir,PackageVersion,PackageOutputPath,NuGetPackageRoot)"
property() {
  node -e 'console.log(JSON.parse(process.argv[1]).Properties[process.argv[2]])' "$properties" "$1"
}
package_version="$(property PackageVersion)"
tool_out="$(property TargetDir)"
package_out="$(property PackageOutputPath)"
package_cache="$(property NuGetPackageRoot)"
tool="$tool_out/DotKtX.Experimental.LspSupport.dll"

nupkg="$package_out/DotKtX.Experimental.LspSupport.$package_version.nupkg"
entries="$(unzip -Z1 "$nupkg")"
for entry in LICENSE.txt NOTICE.txt build/dotkt-version.txt \
  build/DotKtX.Experimental.LspSupport.targets \
  tools/net10.0/any/DotKtX.Experimental.LspSupport.dll \
  tools/net10.0/any/DotKtX.Experimental.LspSupport.deps.json \
  tools/net10.0/any/DotKtX.Experimental.LspSupport.runtimeconfig.json; do
  grep -Fxq "$entry" <<<"$entries"
done
if grep -Eq '\.jar$|Google\.Protobuf\.dll$' <<<"$entries"; then
  echo "The package contains a JVM archive or a projection dependency" >&2
  exit 1
fi
unzip -p "$nupkg" DotKtX.Experimental.LspSupport.nuspec >"$verification_dir/package.nuspec"
node -e '
  const xml = require("fs").readFileSync(process.argv[1], "utf8")
  if (!/<id>DotKtX\.Experimental\.LspSupport<\/id>/.test(xml) || /<dependency\s/.test(xml)) process.exit(1)
' "$verification_dir/package.nuspec"

# Restore the freshly packed local version into this repository's test package cache.
rm -rf "$package_cache/dotktx.experimental.lspsupport/$package_version"
smoke_dir="$repo_dir/tests/Smoke"
smoke="$smoke_dir/Smoke.ktproj"
model="$smoke_dir/.dotkt/lsp"
workspace="$smoke_dir/workspace.json"
shim="$model/compatibility/java/io/Serializable.kt"
run_logged "$verification_dir/Smoke.build.log" dotnet build "$smoke" -c Release --force "$@"
smoke_out="$(dotnet msbuild "$smoke" -nologo -p:Configuration=Release "$@" -getProperty:TargetPath)"
intermediate="$(dotnet msbuild "$smoke" -nologo -p:Configuration=Release "$@" -getProperty:IntermediateOutputPath)"
if [[ "$intermediate" != /* ]]; then intermediate="$smoke_dir/$intermediate"; fi
dotnet "$smoke_out" >"$verification_dir/Smoke.actual.txt"
diff -u "$smoke_dir/expected.txt" "$verification_dir/Smoke.actual.txt"

node - "$workspace" "$intermediate/dotkt-lsp-klibs.rsp" "$shim" <<'JS'
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const [workspaceFile, klibList, shim] = process.argv.slice(2)
const model = JSON.parse(fs.readFileSync(workspaceFile, "utf8"))
const [module] = model.modules
const [library] = model.libraries
assert.equal(model.modules.length, 1)
assert.equal(model.libraries.length, 1)
assert.equal(library.type, null)
assert.deepEqual(module.dependencies, [
    { type: "moduleSource" },
    { type: "library", name: library.name, scope: "compile" },
])
const roots = library.roots.map(root => root.path)
assert.deepEqual(roots, [...new Set(fs.readFileSync(klibList, "utf8").trim().split(/\r?\n/))].sort())
for (const name of ["kotlin-stdlib-clr-frontend.klib", "System.Runtime.klib", "DotKtX.LspSupport.ReceiverFixture.klib"]) {
    assert(roots.some(root => path.basename(root) === name), name)
}
assert(roots.every(root => path.isAbsolute(root) && fs.existsSync(root) && !root.endsWith(".jar")))
assert.equal(model.javaSettings, undefined)
const [settings] = model.kotlinSettings
assert.equal(settings.module, module.name)
assert.equal(settings.kind, "source_set_holder")
assert.equal(settings.isHmppEnabled, true)
assert.equal(settings.compilerArguments[0], "M")
const compiler = JSON.parse(settings.compilerArguments.slice(1))
assert.equal(compiler.companionBlocks, true)
assert.match(settings.additionalArguments, /(?:^| )-Xcompanion-blocks(?: |$)/)
assert(module.contentRoots.some(root => root.sourceRoots.some(source =>
    path.join(source.path, "java", "io", "Serializable.kt") === shim)))
assert.match(fs.readFileSync(shim, "utf8"), /package java\.io\s+internal interface Serializable/)
JS

test ! -e "$model/libraries/dotkt-klib-java-stubs.jar"
test ! -e "$model/projection-report.md"

mtime() {
  node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$1"
}
stamp_time="$(mtime "$model/.stamp")"
workspace_time="$(mtime "$workspace")"
run_logged "$verification_dir/Smoke.incremental.log" dotnet build "$smoke" -c Release "$@"
test "$(mtime "$model/.stamp")" = "$stamp_time"
test "$(mtime "$workspace")" = "$workspace_time"

rm "$shim"
run_logged "$verification_dir/Smoke.repair.log" dotnet build "$smoke" -c Release "$@"
test -f "$shim"
test "$(mtime "$workspace")" = "$workspace_time"
if grep -Fq 'Serializable.kt' "$intermediate/dotkt-kotc.rsp" "$intermediate/dotkt-lsp-sources.rsp"; then
  echo "The analysis-only compatibility source reached the DotKt compiler or project source list" >&2
  exit 1
fi

# Exercise migration and workspace ownership with an independent project directory.
migration_dir="$(mktemp -d "$verification_dir/migration.XXXXXX")"
trap 'rm -rf -- "$migration_dir"' EXIT
legacy="$migration_dir/.dotkt/lsp"
mkdir -p "$legacy/libraries" "$legacy/stubs"
touch "$legacy/libraries/dotkt-klib-java-stubs.jar" "$legacy/stubs/Old.kt" "$legacy/projection-report.md"
printf '%s\n' '{"modules":[{"name":"DotKtx.Experimental.LspSupport:legacy"}]}' >"$migration_dir/workspace.json"
generate() {
  dotnet "$tool" generate --project "$migration_dir" --name legacy --output "$legacy" \
    --sources "$intermediate/dotkt-lsp-sources.rsp" --klibs "$intermediate/dotkt-lsp-klibs.rsp"
}
generate
test -f "$legacy/compatibility/java/io/Serializable.kt"
test ! -e "$legacy/libraries/dotkt-klib-java-stubs.jar"
test ! -e "$legacy/stubs/Old.kt"
test ! -e "$legacy/projection-report.md"

foreign_model='{"modules":[{"name":"custom"}]}'
printf '%s\n' "$foreign_model" >"$migration_dir/workspace.json"
if generate >"$verification_dir/foreign-workspace.log" 2>&1; then
  echo "The generator accepted a foreign workspace" >&2
  exit 1
fi
grep -Fq 'refusing to overwrite' "$verification_dir/foreign-workspace.log"
dotnet "$tool" clean --project "$migration_dir" --output "$legacy"
test "$(cat "$migration_dir/workspace.json")" = "$foreign_model"
test ! -e "$legacy"

run_logged "$verification_dir/Smoke.clean.log" dotnet clean "$smoke" -c Release "$@" -p:DotKtxExperimentalLspSupportEnabled=false
test ! -e "$workspace"
test ! -e "$shim"
test ! -e "$model/.stamp"
test ! -e "$intermediate/dotkt-lsp-klibs.rsp"
test ! -e "$intermediate/dotkt-lsp-sources.rsp"
run_logged "$verification_dir/Smoke.rebuild.log" dotnet build "$smoke" -c Release "$@"
test -f "$workspace"
test -f "$shim"

echo "DotKtX.Experimental.LspSupport: package, KLIB workspace, incremental build, migration and cleanup verified"
