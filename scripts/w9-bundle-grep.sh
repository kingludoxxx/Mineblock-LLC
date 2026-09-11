#!/usr/bin/env bash
# W9 / R20 + R15 check: the video-launcher HOST and the admin TOKEN must appear
# NOWHERE in the client source and NOWHERE in the built bundle.
#
# The file list is built as an ARRAY on purpose. PROOF-W6.md § 2g records a
# FALSE GREEN produced by `grep -rn -- "$t" $FILES` with an unquoted variable:
# the whole list arrived as ONE argument, grep read no file at all, and every
# needle answered 0. The POSITIVE CONTROL is what makes a zero mean something —
# if it does not BITE, the script exits 2 instead of printing CLEAN.
#
# Second bite of the same lesson, recorded here because it cost a run: the first
# version of THIS script used `declare -A` for the per-tree control. macOS ships
# bash 3.2, which has no associative arrays, so every control lookup expanded to
# nothing, `[ "$n" -eq 0 ]` was a syntax error, and the script printed
# "RESULT: CLEAN" and exited 0 while checking nothing. No associative arrays.
set -u
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# FIXED-STRING needles that must be ABSENT: the launcher host and the exact token.
NEEDLES=( 'mineblock-video-launcher' 'mb-bdabeb1589f7160234f33dfb6118ed57' )
# REGEX needles. The brief asked for a bare `mb-`; that is UNSATISFIABLE and would be a
# permanent false red — `mb-` is Tailwind's margin-bottom utility, and it appears 890
# times in client/src and 675 times in the built bundle (measured 2026-09-11, all of them
# `mb-1`..`mb-8` and friends). The needle that carries the meaning is the TOKEN SHAPE:
# `mb-` followed by a long hex run. It catches this token, and it catches a rotated one.
REGEX_NEEDLES=( 'mb-[0-9a-f]{12,}' 'access=mb-' 'video-launcher\.onrender\.com' )
# The needle that MUST bite in every tree. A zero = the grep is blind.
CONTROL='ClickUp Pipeline'

TREES=( "$ROOT/client/src" )
[ -d "$ROOT/client/dist" ] && TREES+=( "$ROOT/client/dist" )

rc=0
for tree in "${TREES[@]}"; do
  files=()
  while IFS= read -r -d '' f; do files+=( "$f" ); done < <(find "$tree" -type f -print0)
  echo "TREE $tree  — ${#files[@]} files scanned"
  if [ "${#files[@]}" -eq 0 ]; then echo "  ABORT: no files found under this tree"; exit 2; fi

  n=$(grep -lF -- "$CONTROL" "${files[@]}" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then verdict=BITES; else verdict='DID NOT BITE'; fi
  printf '  POSITIVE CONTROL  %-44s -> %s file(s)   %s\n' "\"$CONTROL\"" "$n" "$verdict"
  if [ "$n" -eq 0 ]; then echo "  ABORT: control did not bite — the grep read nothing"; exit 2; fi

  for t in "${NEEDLES[@]}"; do
    hits=$(grep -oF -- "$t" "${files[@]}" 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-46s -> %s\n' "\"$t\"" "$hits"
    if [ "$hits" -ne 0 ]; then
      grep -lF -- "$t" "${files[@]}" 2>/dev/null | sed "s|^|      in: |"
      rc=1
    fi
  done
  for t in "${REGEX_NEEDLES[@]}"; do
    hits=$(grep -oE -- "$t" "${files[@]}" 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-46s -> %s  (regex)\n' "/$t/" "$hits"
    if [ "$hits" -ne 0 ]; then
      grep -lE -- "$t" "${files[@]}" 2>/dev/null | sed "s|^|      in: |"
      rc=1
    fi
  done
done
echo
if [ "$rc" -eq 0 ]; then echo "RESULT: CLEAN — host and token absent from every tree scanned";
else echo "RESULT: EXPOSED — see the files listed above"; fi
exit "$rc"
