#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  Cut a release: bump versions, date the changelog, commit and tag.
#  Pushing the tag makes GitHub Actions publish the image and the release.
#
#  usage: scripts/release.sh <version> [--push] [--skip-checks]
#    scripts/release.sh 1.2.0
#    scripts/release.sh 1.3.0-rc.1 --push
#
#  See RELEASING.md for the full procedure.
# ─────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=""
PUSH=false
CHECKS=true
for arg in "$@"; do
  case "$arg" in
    --push)        PUSH=true ;;
    --skip-checks) CHECKS=false ;;
    -h|--help)     sed -n '2,13p' "$0"; exit 0 ;;
    -*)            echo "Unknown option: $arg" >&2; exit 1 ;;
    *)             VERSION="${arg#v}" ;;
  esac
done

die() { echo "❌ $*" >&2; exit 1; }

[ -n "$VERSION" ] || die "usage: scripts/release.sh <version> [--push] [--skip-checks]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "'$VERSION' is not a semantic version (e.g. 1.2.0 or 1.3.0-rc.1)"
TAG="v$VERSION"

# ── Repository state ──────────────────────────
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "release from the main branch"
[ -z "$(git status --porcelain)" ]                || die "working tree is not clean"
git fetch --quiet --tags origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main (pull or push first)"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"

# ── Changelog has something to release ────────
node -e '
  const s = require("fs").readFileSync("CHANGELOG.md", "utf8");
  const m = s.match(/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[|^\[Unreleased\]:|(?![\s\S]))/m);
  if (!m) { console.error("CHANGELOG.md has no ## [Unreleased] section"); process.exit(1); }
  if (!m[1].trim()) { console.error("## [Unreleased] in CHANGELOG.md is empty — describe the changes first"); process.exit(1); }
' || die "fix CHANGELOG.md"

# ── Checks ────────────────────────────────────
if $CHECKS; then
  echo "🔎 Running checks (skip with --skip-checks)"
  ( cd backend  && npm ci --silent && npm run typecheck --silent && npm test --silent >/dev/null && npm run build --silent )
  ( cd frontend && npm ci --silent && npm run typecheck --silent && npm run build --silent >/dev/null )
  diff -q backend/src/types.ts frontend/src/types.ts >/dev/null || die "frontend/src/types.ts is out of sync with backend/src/types.ts"
  echo "✅ Checks passed"
fi

# ── Bump versions ─────────────────────────────
for p in backend frontend; do
  ( cd "$p" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null )
done

# ── Date the changelog and update compare links ──
REPO_URL="${REPO_URL:-$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')}"
PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
VERSION="$VERSION" PREV_TAG="$PREV_TAG" REPO_URL="$REPO_URL" node -e '
  const fs = require("fs");
  const { VERSION, PREV_TAG, REPO_URL } = process.env;
  const today = new Date().toISOString().slice(0, 10);
  let s = fs.readFileSync("CHANGELOG.md", "utf8");
  s = s.replace(/^## \[Unreleased\]\s*\n/m, `## [Unreleased]\n\n## [${VERSION}] - ${today}\n\n`);
  s = s.replace(/^\[Unreleased\]: .*\n?/m, "");
  const link = PREV_TAG ? `${REPO_URL}/compare/${PREV_TAG}...v${VERSION}` : `${REPO_URL}/releases/tag/v${VERSION}`;
  s = s.trimEnd() + `\n\n[Unreleased]: ${REPO_URL}/compare/v${VERSION}...HEAD\n[${VERSION}]: ${link}\n`;
  // keep all link references together at the end
  const lines = s.split("\n");
  const refs = lines.filter(l => /^\[[^\]]+\]: https?:\/\//.test(l));
  const body = lines.filter(l => !/^\[[^\]]+\]: https?:\/\//.test(l)).join("\n").trimEnd();
  const order = r => r.startsWith("[Unreleased]") ? 0 : r.startsWith(`[${VERSION}]`) ? 1 : 2;
  refs.sort((a, b) => order(a) - order(b));
  fs.writeFileSync("CHANGELOG.md", body + "\n\n" + [...new Set(refs)].join("\n") + "\n");
'

# ── Commit + tag ──────────────────────────────
git add CHANGELOG.md backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json
git commit --quiet -m "release: $TAG"
git tag -a "$TAG" -m "GlobeGate $TAG"
echo "✅ Created commit and tag $TAG"

if $PUSH; then
  git push --atomic origin main "$TAG"
  echo "🚀 Pushed. Follow the build: $REPO_URL/actions/workflows/publish.yml"
else
  echo
  echo "Review with:   git show $TAG"
  echo "Publish with:  git push --atomic origin main $TAG"
  echo "Undo with:     git tag -d $TAG && git reset --hard HEAD~1"
fi
