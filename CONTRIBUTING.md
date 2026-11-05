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
npm ci                 # the development dependencies exactly as package-lock.json pins them
npm run typecheck
npm test               # unit and integration tests, no Docker needed
npm run test:docker    # the cage and `protect --inspect` against a real Docker daemon
```

The [Development](README.md#development) section of the README has the longer runs: the
property-based tests with more cases, and mutation testing.

## Proposing a change

Send a pull request against `main`. For a large change, open an issue first, so that the approach is
agreed before the code is written. The [ci workflow](.github/workflows/ci.yml) runs the typecheck and
the tests on Linux and Windows, and the Docker tests on Linux, and CodeQL analyses the code; all of
them must pass. The maintainer reviews every pull request before it is merged.

## What a change needs

- A test that fails without it: for a fix, one that reproduces the bug; for new behaviour, one that
  covers it. Say in the commit message that you saw it fail. A change to code that reads untrusted
  input (what a server sends, a client's configuration file) also extends the property-based tests,
  `test/*.fuzz.test.ts`.
- `npm run typecheck` and `npm test` passing on Linux and on Windows, as CI runs them, and
  `npm run test:docker` when the change touches the cage.
- No runtime dependencies. mcpcage stands between a client and code it does not trust, and whatever
  it loads at run time is code its users must trust too: package.json has no `dependencies`, and
  keeps none.
- One change per commit. The subject says what the commit does; the body says what was seen, its
  cause, the fix, and how it was checked.
- README.md and THREAT-MODEL.md updated where behaviour changes, and a line in CHANGELOG.md for
  anything users will notice.

Contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of mcpcage.
