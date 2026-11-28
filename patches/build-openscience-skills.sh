#!/usr/bin/env bash
# build-openscience-skills.sh
# Build the BIG skills pack: OpenScience's science-skill library (stripped of product
# plumbing) MERGED with ECC's engineering/agent skills, packaged as
# openscience-skills.tar.gz — a downloadable RELEASE ASSET (install into ~/.claude/skills,
# discovered via "skills/**/SKILL.md"). Too many files to compile into the binary, so
# they ship as one pack.
#
# Essence-only: ships the *knowledge* (SKILL.md + references/scripts), NOT the OpenScience
# cloud (Atlas graph, dashboard sync, `openscience`/`atlas` CLIs) and NOT the ECC harness
# plumbing (only ECC's canonical repo-root skills/ tree; .agents/.kiro/.cursor copies and
# docs/<lang> translations are skipped). ECC skills land under their own `ecc/` category
# dir at the pack root, so they can never collide with the OpenScience category dirs.
#
# Best-effort by contract: exits non-zero on any failure so the caller (the build
# workflow) can SKIP the pack without failing the core build. The ECC merge is
# best-effort WITHIN that: if ECC can't be fetched, we still ship the OpenScience pack.
#
# Usage:   build-openscience-skills.sh [out.tar.gz]
# Env:     OS_SKILLS_SRC=/path/to/backend/cli/skills   # reuse a local tree, skip cloning
#          ECC_SKILLS_SRC=/path/to/ECC/skills          # reuse a local tree, skip cloning
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
OS_COUNT=$(find "$PACK" -name SKILL.md | wc -l | tr -d ' ')

# 3b) merge ECC skills (canonical repo-root skills/ only) under ecc/ — BEST-EFFORT:
#     any failure here is a WARN, never fatal; we still ship the OpenScience pack.
#     Runs after de-brand on purpose so the OpenScience sed never touches ECC files.
ECC_UPSTREAM="https://github.com/affaan-m/ECC"
if [ -n "${ECC_SKILLS_SRC:-}" ] && [ -d "$ECC_SKILLS_SRC" ]; then
  echo "using local ECC skills source: $ECC_SKILLS_SRC"
  mkdir -p "$PACK/ecc"
  cp -a "$ECC_SKILLS_SRC/." "$PACK/ecc/" || { echo "WARN: ECC local copy failed — packing without ECC"; rm -rf "$PACK/ecc"; }
else
  echo "sparse-cloning $ECC_UPSTREAM (skills only)..."
  if git clone --no-checkout --filter=blob:none --depth 1 "$ECC_UPSTREAM" "$WORK/ecc" &&
     git -C "$WORK/ecc" sparse-checkout set --no-cone "skills" &&
     git -C "$WORK/ecc" checkout &&
     [ -d "$WORK/ecc/skills" ]; then
    mkdir -p "$PACK/ecc"
    cp -a "$WORK/ecc/skills/." "$PACK/ecc/" || { echo "WARN: ECC copy failed — packing without ECC"; rm -rf "$PACK/ecc"; }
  else
    echo "WARN: ECC fetch failed — packing without ECC"
  fi
fi
ECC_COUNT=$(find "$PACK/ecc" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
echo "ECC skills merged: $ECC_COUNT"

# 4) package (tarball root holds the category dirs; extract into ~/.claude/skills)
COUNT=$(find "$PACK" -name SKILL.md | wc -l | tr -d ' ')
if [ "$OS_COUNT" -lt 100 ]; then echo "only $OS_COUNT OpenScience skills found — refusing to package a partial pack"; exit 15; fi
tar czf "$OUT" -C "$PACK" . || { echo "tar failed"; exit 20; }
echo "packed $COUNT skills (openscience=$OS_COUNT ecc=$ECC_COUNT) -> $OUT ($(du -h "$OUT" | cut -f1))"
