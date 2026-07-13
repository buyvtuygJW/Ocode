#!/usr/bin/env bash
# build-openscience-skills.sh
# Fetch OpenScience's science-skill library, strip product plumbing, and package it as
# openscience-skills.tar.gz — a downloadable RELEASE ASSET (install into ~/.claude/skills,
# discovered via "skills/**/SKILL.md"). Skills are too many (~1,500 files) to compile into
# the binary, so they ship as a pack.
#
# Essence-only: ships the *knowledge* (SKILL.md + references/scripts), NOT the OpenScience
# cloud (Atlas graph, dashboard sync, `openscience`/`atlas` CLIs).
#
# Best-effort by contract: exits non-zero on any failure so the caller (the build
# workflow) can SKIP the pack without failing the core build.
#
# Usage:   build-openscience-skills.sh [out.tar.gz]
# Env:     OS_SKILLS_SRC=/path/to/backend/cli/skills   # reuse a local tree, skip cloning
set -uo pipefail

UPSTREAM="https://github.com/synthetic-sciences/openscience"
OUT="${1:-openscience-skills.tar.gz}"
WORK="$(mktemp -d)"
PACK="$WORK/openscience-skills"
trap 'rm -rf "$WORK"' EXIT

echo "== build-openscience-skills =="
mkdir -p "$PACK"

# 1) obtain the skills tree (sparse partial clone unless a local source is provided)
if [ -n "${OS_SKILLS_SRC:-}" ] && [ -d "$OS_SKILLS_SRC" ]; then
  echo "using local skills source: $OS_SKILLS_SRC"
  cp -a "$OS_SKILLS_SRC/." "$PACK/" || { echo "copy failed"; exit 13; }
else
  echo "sparse-cloning $UPSTREAM (backend/cli/skills only)..."
  git clone --no-checkout --filter=blob:none --depth 1 "$UPSTREAM" "$WORK/src" || { echo "clone failed"; exit 10; }
  git -C "$WORK/src" sparse-checkout set --no-cone "backend/cli/skills"        || { echo "sparse-checkout failed"; exit 11; }
  git -C "$WORK/src" checkout                                                   || { echo "checkout failed"; exit 12; }
  cp -a "$WORK/src/backend/cli/skills/." "$PACK/"                               || { echo "copy failed"; exit 13; }
fi

# 2) drop pure-product skills (OpenScience cloud/Atlas/dashboard plumbing — dead here)
for d in research/initialize-atlas-graph other/skill-installer; do
  if [ -e "$PACK/$d" ]; then rm -rf "$PACK/$d" && echo "dropped product skill: $d"; fi
done

# 3) de-brand — unambiguous product tokens ONLY. Deliberately leaves 'atlas' (Cell Atlas,
#    ATLAS detector...), bare 'synthetic' (synthetic biology/data/lethality) and 'daytona'.
mapfile -t FILES < <(grep -rIl -e 'OpenScience' -e 'openscience' -e 'syntheticsciences' -e 'synthetic-sciences' -e 'Synthetic Sciences' "$PACK" 2>/dev/null || true)
if [ "${#FILES[@]}" -gt 0 ]; then
  echo "de-branding ${#FILES[@]} files..."
  sed -i \
    -e 's#https\{0,1\}://app\.syntheticsciences\.ai#your provider dashboard#g' \
    -e 's/app\.syntheticsciences\.ai/your provider dashboard/g' \
    -e 's/synthetic-sciences/ocode/g' \
    -e 's/Synthetic Sciences/OCode/g' \
    -e 's/syntheticsciences/ocode/g' \
    -e 's/OpenScience/OCode/g' \
    -e 's/openscience/ocode/g' \
    "${FILES[@]}" || { echo "sed de-brand failed"; exit 14; }
fi
RESID=$(grep -rIl -e 'openscience' -e 'syntheticsciences' "$PACK" 2>/dev/null | wc -l | tr -d ' ')
echo "residual product-token files after de-brand: $RESID (expect 0)"

# 4) package (tarball root holds the category dirs; extract into ~/.claude/skills)
COUNT=$(find "$PACK" -name SKILL.md | wc -l | tr -d ' ')
if [ "$COUNT" -lt 100 ]; then echo "only $COUNT skills found — refusing to package a partial pack"; exit 15; fi
tar czf "$OUT" -C "$PACK" . || { echo "tar failed"; exit 20; }
echo "packed $COUNT skills -> $OUT ($(du -h "$OUT" | cut -f1))"
