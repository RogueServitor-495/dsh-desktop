#!/bin/bash
# stub llvm-rc — lets "cargo check --target x86_64-pc-windows-msvc" run on macOS
# (embed-resource probes/compiles resources in the build script even for check).
# Compile-only: produces an empty .res. Real Windows builds use the real llvm-rc.
# Usage: RC="$(pwd)/scripts/stub-llvm-rc.sh" cargo check --target x86_64-pc-windows-msvc
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "/fo" ]; then out="$a"; fi
  prev="$a"
done
if [ -n "$out" ]; then
  mkdir -p "$(dirname "$out")" 2>/dev/null
  : > "$out"
  exit 0
fi
echo "OVERVIEW: LLVM Resource Converter"
echo "  no-preprocess"
exit 0
