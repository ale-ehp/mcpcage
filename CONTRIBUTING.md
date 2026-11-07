# Contributing to mcpcage

## Bugs and feature requests

Open an issue at <https://github.com/ale-ehp/mcpcage/issues>. For a bug, give the output of
`mcpcage --version` and `mcpcage doctor`, the operating system, the client, the server entry or
command involved (with any secret taken out), what happened and what you expected. Requests for new
features go there too.

Vulnerabilities are the exception: report them privately, through the form that
[SECURITY.md](SECURITY.md) links, never in a public issue.

## Building and testing

You need Node.js 22, the version CI runs, and a Docker engine for the cage tests.

```bash
git clone https://github.com/ale-ehp/mcpcage && cd mcpcage
npm ci                 # the development dependencies exactly as package-lock.json pins them
npm run build && npm link   # `mcpcage` on your PATH is now this clone's
npm run typecheck
npm run lint           # Biome's bug-finding rules, configured in biome.jsonc
npm test               # unit and integration tests, no Docker needed
npm run test:coverage  # the same tests, with the coverage report CI checks
npm run test:docker    # the cage and `protect --inspect` against a real Docker daemon
```

The [Development](README.md#development) section of the README has the longer runs: the
property-based tests with more cases, and mutation testing.

## Proposing a change

Send a pull request against `main`. For a large change, open an issue first, so that the approach is
agreed before the code is written. The [ci workflow](.github/workflows/ci.yml) runs the typecheck and
the tests on Linux and Windows, and the lint and the Docker tests on Linux, and CodeQL analyses the
code; all of them must pass. The maintainer reviews every pull request before it is merged.
[GOVERNANCE.md](GOVERNANCE.md) says how decisions are made and what each role does.

## What a change needs

- A test that fails without it: for a fix, one that reproduces the bug; for new behaviour, one that
  covers it. Say in the commit message that you saw it fail. A change to code that reads untrusted
  input (what a server sends, a client's configuration file) also extends the property-based tests,
  `test/*.fuzz.test.ts`.
- `npm run typecheck` and `npm test` passing on Linux and on Windows, as CI runs them, and
  `npm run test:docker` when the change touches the cage.
- Coverage kept at 80% of the statements in `src/` or more: CI runs `npm run test:coverage` on
  Linux, which fails under the thresholds in vitest.config.ts.
- `npm run lint` passing: CI runs Biome on Linux, and a warning fails it as an error does. A rule
  that is wrong for one line is silenced on that line with a `biome-ignore` comment that says why.
- No runtime dependencies. mcpcage stands between a client and code it does not trust, and whatever
  it loads at run time is code its users must trust too: package.json has no `dependencies`, and
  keeps none.
- One change per commit. The subject says what the commit does; the body says what was seen, its
  cause, the fix, and how it was checked.
- README.md and THREAT-MODEL.md updated where behaviour changes, and a line in CHANGELOG.md for
  anything users will notice.

Contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of mcpcage.

## Code of conduct

Everyone who takes part in mcpcage's issues, pull requests and other spaces follows the
[Code of Conduct](CODE_OF_CONDUCT.md), the Contributor Covenant 2.1. Report a breach privately, as
it says.

## Releasing

For the maintainer. The [release workflow](.github/workflows/release.yml) runs on a `v*` tag: it
tests and packs the package, stages it on npm with its provenance, and leaves a draft GitHub
release with the package, its SBOM and its signed provenance. npm serves nothing until the staged
version is approved with two-factor authentication, which the workflow cannot give.

1. Commit the version in package.json and package-lock.json and its CHANGELOG.md entry on `main`,
   as `mcpcage X.Y.Z`, and push.
2. Tag that commit and push the tag: `git tag -a vX.Y.Z -m "mcpcage X.Y.Z"`, then
   `git push origin vX.Y.Z`.
3. Wait for the release workflow to finish. Its summary names the staged version and its stage id.
4. Approve the staged version: on npmjs.com, signed in, open **Staged Packages** in the account
   menu, check the version, click **Approve** and confirm with the security key. From a terminal
   logged in to npm, `npm stage approve <stage-id>` does the same and asks for the second factor.
5. Check that `npm view mcpcage dist-tags.latest` prints X.Y.Z.
6. Publish the draft release: `gh release edit vX.Y.Z --draft=false`, or **Publish release** on
   its page.

A staged version that must not go out is removed with **Reject** on npmjs.com, or with
`npm stage reject <stage-id>`, which also asks for the second factor; then delete the draft
release. A rejected version number can be staged again.
