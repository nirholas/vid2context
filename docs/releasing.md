# Releasing

Two packages are published to npm: `vid2context` (the CLI, `npx vid2context`) and `vid2context-mcp` (the MCP server, `npx vid2context-mcp`). The workspace packages stay private and export TypeScript source; the published packages are bundles built from them.

## Versioning

One version number covers both packages. It lives in four manifests that always move together: the root `package.json`, `packages/cli/package.json` and `packages/mcp/package.json` (the bundles take their versions from these two, see `packages/discovery/src/meta.ts`), and `packages/server/package.json`, which the HTTP API reports from `/health` (it was left at 0.1.0 until 0.2.1, so the public instance reported the wrong version). Release notes live in the root [CHANGELOG.md](../CHANGELOG.md), in the Keep a Changelog format.

```sh
node tooling/release/version.mjs patch     # or minor, major, or an explicit 1.2.3
```

[tooling/release/version.mjs](../tooling/release/version.mjs) changes only the `"version"` line of the four manifests and the `version` and `date-released` lines of `CITATION.cff`, moves the `## [Unreleased]` notes under `## [x.y.z] - date`, opens a fresh Unreleased section and updates the compare links. It refuses when the Unreleased section is empty, so every release says what changed. It does not commit, tag or publish; it prints those commands.

Why not Changesets: Changesets writes a CHANGELOG.md per package and versions each workspace on its own, while this repo keeps one hand-written changelog at the root and ships two bundles under one version from more than 50 private workspaces. A 150-line script that fits that shape is simpler than configuring Changesets around it, and adds no dependency.

## Building

```sh
npm run build:npm
```

`packages/discovery` bundles each bin with esbuild into one ESM file with a `#!/usr/bin/env node` banner, targeting Node 22, and writes the package under `packages/discovery/dist/npm/<name>/`: a generated `package.json` (name, version, `bin`, `engines: { "node": ">=22" }`, `files`, `license: Apache-2.0`, repository), `README.md`, `LICENSE` and `THIRD_PARTY_LICENSES.txt`. No workspace manifest is edited. This tooling reuses that build instead of adding a second bundler.

`node tooling/release/smoke.mjs` runs the bundles the way npx does: `vid2context --help` must print usage, and `vid2context-mcp` must answer a JSON-RPC `initialize` on stdio with nothing but protocol on stdout. `npm run ci` runs it right after the build.

## Dry run

```sh
npm run release:dry
```

[tooling/release/release.mjs](../tooling/release/release.mjs) builds, then for each bundle writes `sbom.cdx.json` (CycloneDX, from `npm sbom --omit dev` over the source workspace's production tree, which is what esbuild inlines, renamed to the published package) and runs `npm publish --dry-run`, which prints the tarball contents. Nothing is published.

It fails if npm would rewrite a generated manifest at publish time. npm does this silently, for example by dropping a `bin` entry it considers invalid, which would ship a package that npx cannot run. One rewrite is harmless and allowed: npm strips a leading `./` from a bin path and reports it as "script name ... was invalid and removed", although it keeps the entry. [tooling/release/npm-output.mjs](../tooling/release/npm-output.mjs) accepts exactly that case and fails on any other correction. The SBOM is a release artifact next to the tarball, not part of it.

If the version is already on npm, npm refuses even the dry run, after printing the tarball. The dry run then reports which bundles need a version bump and still exits 0; `--publish` refuses before anything is published.

## Publishing

Publishing happens on Cloud Build when a version tag is pushed (setup in [ci.md](ci.md)):

```sh
node tooling/release/version.mjs minor
npm install                                   # sync package-lock.json
npm run ci && npm run release:dry
git commit -m "chore(release): v0.2.0" -- package.json packages/cli/package.json packages/mcp/package.json packages/server/package.json package-lock.json CHANGELOG.md CITATION.cff
git tag -a v0.2.0 -m "v0.2.0"
git push origin main v0.2.0
```

[tooling/cloudbuild/release.yaml](../tooling/cloudbuild/release.yaml) runs the full CI, then `release.mjs --no-build --publish --tag v0.2.0`. That refuses unless the tag equals `v<version>` of every bundle, dry-runs every bundle before publishing any, and authenticates with the `npm-token` secret through `NPM_TOKEN`. The SBOMs are copied to `gs://<_ARTIFACT_BUCKET>/releases/<tag>/` when that substitution is set.

To publish by hand instead, log in with `npm login` and run `node tooling/release/release.mjs --publish --tag v0.2.0`. A token works too, without touching `~/.npmrc`: put `//registry.npmjs.org/:_authToken=<token>` in a temporary file and run with `NPM_CONFIG_USERCONFIG=<that file>`, then delete it.

npm now answers a successful publish with "Your package is being processed and may take a few minutes to become available": `npm view` and the registry return 404 for the new version for a minute or two (about four for v0.2.0). That is not a failure; check `https://registry.npmjs.org/<name>/<version>` before retrying.

## Release checklist

Everything a release touches, in order. v0.2.0 tripped on several of these, so each says what goes wrong when it is skipped.

1. **Versions agree.** `version.mjs` refuses relative bumps while the three manifests differ (v0.2.0 found the root at 0.1.0 and the bundles at 0.1.1). Fix the odd one out by hand to the last published version, then bump.
2. **Bump and cut the changelog:** `node tooling/release/version.mjs <part>`, then `npm install` to sync `package-lock.json`. The script also sets `version` and `date-released` in `CITATION.cff` (what GitHub's "Cite this repository" and citation tools read).
3. **Regenerate the directory manifests:** `npm run discovery:gen`. `server.json` and `gemini-extension.json` carry the version, and `packages/discovery/test/manifests.test.ts` fails until they match.
4. **Full CI:** `npm run ci`, every step green, then `npm run release:dry`.
5. **Commit, tag, push:** the commit and tag commands above.
6. **Publish to npm** (Cloud Build on the tag, or by hand as above), then confirm `https://registry.npmjs.org/vid2context/<version>` and `.../vid2context-mcp/<version>` answer 200 and `npx vid2context@<version> --help` runs.
7. **GitHub release:** `gh release create v<version> --title "vid2context <version>" --notes-file <notes> --verify-tag --latest`, with the notes cut from that version's CHANGELOG section. Without it the repository page keeps showing the previous release as latest.
8. **MCP Registry:** `mcp-publisher login github` (interactive, as the repository owner), then `mcp-publisher publish` from the repository root. It reads the regenerated `server.json`. Check `https://registry.modelcontextprotocol.io/v0/servers?search=vid2context` lists the new version.
9. **The public instance:** `npm run deploy` (needs `CLOUDFLARE_API_TOKEN`), then `curl https://vid2context.com/api/v1/health` lists the expected sources. vid2context.com ran a build older than the X provider until 2026-11-19, so every X link failed there while npm and the CLI worked.

## Provenance

npm provenance (`npm publish --provenance`) needs an OIDC identity from a supported CI provider, currently GitHub Actions or GitLab CI. Cloud Build is not one, and GitHub Actions is unavailable on this account, so releases publish without provenance. The SBOM, the tag and the Cloud Build log are the audit trail. If GitHub Actions becomes available again, publishing from a workflow with `--provenance` adds the attestation.
