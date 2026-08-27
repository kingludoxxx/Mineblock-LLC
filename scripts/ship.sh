#!/usr/bin/env bash
#
# ship.sh — the safe path from a feature branch to a verified live deploy.
#
# WHY THIS EXISTS
# Two sessions work this repo at once. On 2026-08-27 that produced, in one hour:
#   * a merge that hit a conflict while the chain used `;` instead of `&&`, so
#     the push ran anyway and reported success on someone else's commit
#   * a feature branch six days behind main, guaranteeing conflicts in a
#     12,000-line file both sessions were editing
#   * three deploys silently superseded by the other session's deploys, so the
#     code that went live was not the code that was triggered
#
# Every one of those is caught below. The script is deliberately paranoid and
# deliberately loud: it would rather stop than half-ship.
#
#   Usage:  scripts/ship.sh "commit message"
#           scripts/ship.sh --no-deploy "commit message"   # merge + push only
#           scripts/ship.sh --dry-run                      # checks, no writes
#
set -Eeuo pipefail          # -e: stop on error. This is the `;` bug, structurally fixed.

FEATURE_WORKTREE="/Users/ludo/statics-pipeline-v2"
INTEGRATOR_WORKTREE="/Users/ludo/Puure-integrator"
SERVICE_ID="srv-d9r4elcs728c73d01gug"
SETTINGS="$HOME/.claude/settings.json"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$GRN" "$OFF" "$1"; }
warn() { printf '%s !! %s%s\n' "$YEL" "$1" "$OFF"; }
die()  { printf '\n%sFAILED:%s %s\n' "$RED" "$OFF" "$1" >&2; exit 1; }

DEPLOY=1; DRY=0; MSG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-deploy) DEPLOY=0; shift ;;
    --dry-run)   DRY=1; DEPLOY=0; shift ;;
    *)           MSG="$1"; shift ;;
  esac
done

cd "$FEATURE_WORKTREE"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] && die "you are on main. Work on a feature branch."
step "branch: $BRANCH"

# ── 1. commit anything outstanding ─────────────────────────────────────────
# Scoped adds only. A blanket `git add -A` here once nearly shipped another
# session's half-written feature that happened to be sitting in the tree.
if [[ -n "$(git status --porcelain -- server client scripts)" ]]; then
  [[ $DRY == 1 ]] && { warn "dry-run: would commit changes in server/ client/ scripts/"; }
  if [[ $DRY == 0 ]]; then
    [[ -z "$MSG" ]] && die "uncommitted changes but no commit message given"
    git add -- server client scripts
    git commit -q -m "$MSG"
    step "committed: $(git rev-parse --short HEAD)"
  fi
else
  step "working tree clean"
fi
MINE="$(git rev-parse HEAD)"

# ── 2. take main BEFORE anything else ──────────────────────────────────────
# Merging main in first is the whole point: conflicts get resolved here, in the
# branch, with full context — not discovered halfway through a push.
step "merging origin/main into $BRANCH"
git fetch -q origin
if ! git merge --no-ff --no-edit origin/main -q 2>/dev/null; then
  git diff --name-only --diff-filter=U | sed 's/^/    /'
  die "conflicts with origin/main. Resolve them here, then re-run."
fi
git diff --name-only --diff-filter=U | grep -q . && die "unresolved conflicts remain"

# ── 3. prove it still builds and passes ────────────────────────────────────
step "checking server syntax"
while IFS= read -r f; do node --check "$f" >/dev/null || die "syntax error in $f"; done \
  < <(git diff --name-only "origin/main...HEAD" -- 'server/**/*.js' | grep -E '\.js$' || true)

if git diff --name-only "origin/main...HEAD" -- client | grep -q .; then
  step "building client"
  ( cd client && npx --no-install vite build >/dev/null 2>&1 ) || die "client build failed"
fi

if [[ -x scripts/test.sh ]]; then
  step "running tests"
  ./scripts/test.sh || die "tests failed"
fi

[[ $DRY == 1 ]] && { step "dry-run complete — nothing pushed"; exit 0; }

# ── 4. integrate and push ──────────────────────────────────────────────────
step "merging $BRANCH into main"
cd "$INTEGRATOR_WORKTREE"
git fetch -q origin
git merge --no-ff --no-edit origin/main -q || die "integrator could not take origin/main"
git merge --no-ff --no-edit "$BRANCH" -q || die "integrator could not take $BRANCH"
git diff --name-only --diff-filter=U | grep -q . && die "conflicts in the integrator worktree"

git push -q origin main || die "push rejected — someone pushed while we worked. Re-run."
PUSHED="$(git rev-parse HEAD)"
step "pushed ${PUSHED:0:7}"

# The check that would have caught the false success: is MY commit actually an
# ancestor of what landed on main?
git merge-base --is-ancestor "$MINE" "$PUSHED" \
  || die "pushed commit does not contain ${MINE:0:7} — your work did NOT land"
step "verified ${MINE:0:7} is contained in main"

[[ $DEPLOY == 0 ]] && { step "--no-deploy: stopping before deploy"; exit 0; }

# ── 5. deploy, and verify the LIVE commit is ours ──────────────────────────
command -v python3 >/dev/null || die "python3 needed for the deploy step"
KEY="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('$SETTINGS')))['mcpServers']['render']['env']['RENDER_API_KEY'])")"
[[ -n "$KEY" ]] || die "no RENDER_API_KEY in $SETTINGS"

step "triggering deploy"
DEP="$(curl -sS -X POST "https://api.render.com/v1/services/$SERVICE_ID/deploys" \
        -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
printf '    %s\n' "$DEP"

# Poll EVERY terminal state, not just `live`. Waiting only for `live` is how a
# superseded deploy looks identical to one still building.
for _ in $(seq 1 120); do
  S="$(curl -sS "https://api.render.com/v1/services/$SERVICE_ID/deploys/$DEP" \
        -H "Authorization: Bearer $KEY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')"
  case "$S" in
    live) step "deploy live"; break ;;
    build_failed|update_failed|canceled|pre_deploy_failed) die "deploy ended: $S" ;;
    deactivated) warn "this deploy was superseded by another session's deploy"; break ;;
  esac
  sleep 10
done

# Final authority: whatever is actually serving must contain our commit. Another
# session's deploy may have replaced ours — that is fine, so long as it carries
# our work forward.
LIVE="$(curl -sS "https://api.render.com/v1/services/$SERVICE_ID/deploys?limit=20" \
  -H "Authorization: Bearer $KEY" \
  | python3 -c 'import sys,json;[print(d["deploy"]["commit"]["id"]) or exit() for d in json.load(sys.stdin) if d["deploy"]["status"]=="live"]')"
cd "$FEATURE_WORKTREE"
git fetch -q origin
if git merge-base --is-ancestor "$MINE" "$LIVE" 2>/dev/null; then
  step "LIVE ${LIVE:0:7} contains ${MINE:0:7} — shipped"
else
  die "live commit ${LIVE:0:7} does NOT contain ${MINE:0:7} — your work is pushed but NOT serving"
fi
