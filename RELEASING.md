# Releasing GlobeGate

Releases are cut from `main` by pushing a `vX.Y.Z` tag. GitHub Actions then builds, tests and publishes the image and creates the GitHub Release. `scripts/release.sh` prepares the tag so versions and changelog never drift.

## What runs where

| Event | Workflow | Result |
|---|---|---|
| Pull request | `CI` | Typecheck, tests, builds, image build + smoke test (nothing published) |
| Push to `main` | `CI`, `Publish` | `ghcr.io/corentingrard/globegate:edge` and `:sha-<commit>` |
| Tag `v1.2.3` | `Publish` | `:1.2.3`, `:1.2`, `:1`, `:latest` + GitHub Release |
| Tag `v1.3.0-rc.1` | `Publish` | `:1.3.0-rc.1` only + GitHub pre-release |

Every published image is multi-arch (amd64, arm64), smoke-tested before it's pushed, and ships with an SBOM and build provenance.

## Choosing the version

[Semantic Versioning](https://semver.org/), from the user's point of view:

- **Patch** (`1.2.3` → `1.2.4`): bug fixes only.
- **Minor** (`1.2.3` → `1.3.0`): new features or options; existing setups keep working.
- **Major** (`1.2.3` → `2.0.0`): something users must change, e.g. a renamed environment variable, a different volume layout, or a removed feature. Explain the migration in the changelog.

## Procedure

1. **Make sure `main` is ready.** CI is green and `## [Unreleased]` in `CHANGELOG.md` describes everything in this release. Edit the wording now if needed (commit and push it).

2. **Cut the release** from an up-to-date, clean `main`:

   ```bash
   git switch main && git pull
   scripts/release.sh 1.2.0
   ```

   The script checks the repository state, runs the tests and builds, sets the version in both `package.json` files, turns `## [Unreleased]` into `## [1.2.0] - <date>`, updates the compare links, commits `release: v1.2.0` and creates the annotated tag `v1.2.0`. Nothing is pushed yet.

3. **Review** with `git show v1.2.0`. To start over: `git tag -d v1.2.0 && git reset --hard HEAD~1`.

4. **Publish:**

   ```bash
   git push --atomic origin main v1.2.0
   ```

   (or run step 2 with `--push` to do it in one go).

5. **Watch** the [Publish workflow](https://github.com/CorentinGrard/globegate/actions/workflows/publish.yml). It refuses tags that don't match the `package.json` versions or have no changelog section. When it's green, check the [release page](https://github.com/CorentinGrard/globegate/releases) and pull the image:

   ```bash
   docker pull ghcr.io/corentingrard/globegate:1.2.0
   ```

### Pre-releases

```bash
scripts/release.sh 1.3.0-rc.1 --push
```

Published as `:1.3.0-rc.1` and a GitHub pre-release; `:latest` is not moved. When it's good, release `1.3.0` normally. Its changelog section is whatever is under Unreleased at that point, so either leave the rc section and add only the new changes, or merge the rc notes into the final section by hand before running the script.

### If a release goes wrong

- **The workflow failed before pushing the image** (smoke test, version check): fix on `main`, then delete the tag (`git push --delete origin v1.2.0 && git tag -d v1.2.0`) and release again. Reusing the number is fine since nothing was published.
- **A broken image was published**: don't reuse or move tags. Fix forward with a patch release (`1.2.1`) and mention the problem in its changelog entry.

## One-time repository setup

- **Package visibility**: after the first publish, open the `globegate` package on GHCR and set it to **Public** so `docker pull` works without logging in. If the package was first created by another repository, link it to this one under *Package settings → Manage Actions access*.
- **Branch protection** for `main`: require the `CI` checks to pass before merging.
- **Settings → Code security**: enable *Private vulnerability reporting* (used by SECURITY.md) and Dependabot alerts.
