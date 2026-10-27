#!/usr/bin/env bash
# TypeScript consumer matrix. The packed tarball is unpacked into consumer projects (node_modules/thruway.js), and
# test/consumers/ts/*.mts are copied in as .mts/.cts/.ts files and type-checked with TypeScript 5.0.4, 5.4.5, 5.9.3,
# 6.0.3 and 7.0.2:
#   - node16, nodenext (module = resolution; .mts + .cts: the import and the require types) and bundler (module
#     esnext, .ts) × lib es2022 (types []) and es2022 + dom (types []), skipLibCheck false, strict;
#   - exactOptionalPropertyTypes (nodenext .mts + .cts, bundler .mts);
#   - React Native's profile (@react-native/typescript-config 0.87.1: module esnext, bundler, customConditions
#     ["react-native"], its lib list without DOM, types []) on TS >= 5.9 (its lib list names es2024.promise);
#   - RxJS consumers whose own `rxjs` is 7.8.2, 6.6.7, 5.5.12 or 5.4.3 (the repo's dev aliases, linked as
#     node_modules/rxjs), skipLibCheck true (their own d.ts is not clean under every TS; usage errors still count): our
#     Observables into `from`/`Observable.from`, RxJS Observables as Inputs, `rxClient(client, from)` typed with the
#     consumer's RxJS. The interop project tests the rxClient runtime; these cells check the thruway.js/rxjs types only.
# Every cell must pass; the table is printed either way.
#
#   scripts/consumer-matrix.sh <thruway.js-x.y.z.tgz>
#
# TypeScript versions are installed into node_modules/.cache/thruway-consumers/tools with npm --offline (from the npm
# cache) unless THRUWAY_ALLOW_NETWORK=1 (CI). CONSUMER_MATRIX_JOBS sets the parallelism [6].
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARBALL="${1:-}"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "usage: scripts/consumer-matrix.sh <packed thruway.js tarball> (npm pack first)" >&2
  exit 2
fi
case "$TARBALL" in /*) ;; *) TARBALL="$PWD/$TARBALL" ;; esac
JOBS="${CONSUMER_MATRIX_JOBS:-6}"
OFFLINE="--offline"
if [ "${THRUWAY_ALLOW_NETWORK:-0}" = "1" ]; then OFFLINE=""; fi

# --- TypeScript versions --------------------------------------------------------------------------------------------
mkdir -p node_modules/.cache/thruway-consumers/tools
(
  cd node_modules/.cache/thruway-consumers/tools
  printf '{ "name": "thruway-consumer-tools", "private": true }\n' > package.json
  # shellcheck disable=SC2086
  npm install --no-audit --no-fund --ignore-scripts --no-package-lock $OFFLINE \
    ts50@npm:typescript@5.0.4 ts54@npm:typescript@5.4.5 ts59@npm:typescript@5.9.3 \
    ts6@npm:typescript@6.0.3 ts7@npm:typescript@7.0.2 > install.log 2>&1 || {
    cat install.log >&2
    echo "consumer-matrix: could not install the TypeScript versions (offline: set THRUWAY_ALLOW_NETWORK=1 to download)" >&2
    exit 1
  }
)
TOOLS="$ROOT/node_modules/.cache/thruway-consumers/tools/node_modules"

# --- consumer projects: one per RxJS variant --------------------------------------------------------------------------
rm -rf node_modules/.cache/thruway-consumers/cells node_modules/.cache/thruway-consumers/results
mkdir -p node_modules/.cache/thruway-consumers/results
CELLS="$ROOT/node_modules/.cache/thruway-consumers/cells"
RESULTS="$ROOT/node_modules/.cache/thruway-consumers/results"
for variant in plain rx7 rx6 rx5512 rx543; do
  dir="$CELLS/$variant"
  mkdir -p "$dir/node_modules/thruway.js"
  tar -xzf "$TARBALL" -C "$dir/node_modules/thruway.js" --strip-components 1
  case $variant in
    rx7) ln -s "$ROOT/node_modules/rxjs" "$dir/node_modules/rxjs" ;;
    rx6) ln -s "$ROOT/node_modules/rxjs6" "$dir/node_modules/rxjs" ;;
    rx5512) ln -s "$ROOT/node_modules/rxjs5" "$dir/node_modules/rxjs" ;;
    rx543) ln -s "$ROOT/node_modules/rxjs543" "$dir/node_modules/rxjs" ;;
  esac
  printf '{ "name": "consumer-%s", "private": true }\n' "$variant" > "$dir/package.json"
  for src in api dom eopt; do
    for ext in mts cts ts; do cp "test/consumers/ts/$src.mts" "$dir/$src.$ext"; done
  done
  case $variant in
    rx7 | rx6) for ext in mts cts ts; do cp test/consumers/ts/rx7.mts "$dir/rx.$ext"; done ;;
    rx5*) for ext in mts cts ts; do cp test/consumers/ts/rx5/rx5.mts "$dir/rx.$ext"; done ;;
  esac
done

# --- cells -----------------------------------------------------------------------------------------------------------
LIST="$ROOT/node_modules/.cache/thruway-consumers/cells.txt"
: > "$LIST"
RN_LIB='"es2019","es2020.bigint","es2020.date","es2020.number","es2020.promise","es2020.string","es2020.symbol.wellknown","es2021.promise","es2021.string","es2021.weakref","es2022.array","es2022.error","es2022.object","es2022.string","es2024.promise","esnext.promise"'

# cell <name> <variant> <ts> <module> <resolution> <lib-json> <skipLibCheck> <extra-json> <files...>
cell() {
  local name=$1 variant=$2 ts=$3 module=$4 resolution=$5 lib=$6 skip=$7 extra=$8
  shift 8
  local files=""
  for f in "$@"; do files="$files${files:+, }\"$f\""; done
  cat > "$CELLS/$variant/tsconfig.$name.json" <<EOF
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022", "skipLibCheck": $skip,
    "module": "$module", "moduleResolution": "$resolution", "lib": [$lib], "types": []${extra:+, $extra}
  },
  "files": [$files]
}
EOF
  echo "$name $variant $ts" >> "$LIST"
}

for ts in ts50 ts54 ts59 ts6 ts7; do
  for lib in es2022 dom; do
    if [ $lib = dom ]; then libs='"es2022", "dom"'; dom_m=dom.mts; dom_c=dom.cts; dom_t=dom.ts; else libs='"es2022"'; dom_m=; dom_c=; dom_t=; fi
    for res in node16 nodenext; do
      # shellcheck disable=SC2086
      cell "$ts-$res-$lib" plain $ts $res $res "$libs" false "" api.mts api.cts $dom_m $dom_c
    done
    # shellcheck disable=SC2086
    cell "$ts-bundler-$lib" plain $ts esnext bundler "$libs" false "" api.ts $dom_t
  done
  cell "$ts-nodenext-eopt" plain $ts nodenext nodenext '"es2022"' false '"exactOptionalPropertyTypes": true' \
    api.mts api.cts eopt.mts eopt.cts
  cell "$ts-bundler-eopt" plain $ts esnext bundler '"es2022"' false '"exactOptionalPropertyTypes": true' \
    api.ts eopt.ts
  case $ts in
    ts59 | ts6 | ts7)
      cell "$ts-react-native" plain $ts esnext bundler "$RN_LIB" false \
        '"customConditions": ["react-native"], "isolatedModules": true, "esModuleInterop": true, "allowImportingTsExtensions": true, "resolveJsonModule": true' \
        api.ts eopt.ts
      ;;
  esac
  for rx in rx7 rx6 rx5512 rx543; do
    cell "$ts-$rx-bundler" $rx $ts esnext bundler '"es2022", "dom"' true "" api.ts rx.ts
    cell "$ts-$rx-nodenext-cjs" $rx $ts nodenext nodenext '"es2022", "dom"' true "" api.cts rx.cts
    case $rx in rx7 | rx6) cell "$ts-$rx-nodenext-esm" $rx $ts nodenext nodenext '"es2022", "dom"' true "" api.mts rx.mts ;; esac
  done
done

run_cell() {
  local name=$1 variant=$2 ts=$3
  local out rc=0
  out=$(cd "$CELLS/$variant" && node "$TOOLS/$ts/bin/tsc" -p "tsconfig.$name.json" --pretty false 2>&1) || rc=$?
  local version
  version=$(node -p "require('$TOOLS/$ts/package.json').version")
  if [ $rc = 0 ]; then
    printf '%-34s %-7s OK\n' "$name" "$version" > "$RESULTS/$name.txt"
  else
    local count first
    count=$(printf '%s\n' "$out" | grep -c 'error TS' || true)
    first=$(printf '%s\n' "$out" | grep -m1 'error' | cut -c1-200)
    printf '%-34s %-7s FAIL (%s errors) %s\n' "$name" "$version" "$count" "$first" > "$RESULTS/$name.txt"
    printf '%s\n' "$out" > "$RESULTS/$name.log"
  fi
}
export -f run_cell
export CELLS RESULTS TOOLS

total=$(wc -l < "$LIST" | tr -d ' ')
echo "consumer-matrix: $total cells, $JOBS in parallel"
xargs -P "$JOBS" -n 3 bash -c 'run_cell "$@"' _ < "$LIST"

failed=0
while read -r name _ _; do
  cat "$RESULTS/$name.txt"
  if grep -q ' FAIL ' "$RESULTS/$name.txt"; then failed=$((failed + 1)); fi
done < "$LIST"
if [ $failed -gt 0 ]; then
  echo "consumer-matrix: FAILED ($failed of $total cells; full logs in $RESULTS/*.log)" >&2
  exit 1
fi
echo "consumer-matrix: all $total cells OK"
