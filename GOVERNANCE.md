# Governance

mcpcage has one maintainer, the GitHub user [ale-ehp](https://github.com/ale-ehp). The maintainer
makes the final decision on every change, release and security response, after discussing it in
public issues or pull requests.

## How decisions are made

- A proposal starts as an issue or a pull request at <https://github.com/ale-ehp/mcpcage>. For a
  large change, the issue comes first, so that the approach is agreed before the code is written
  ([CONTRIBUTING.md](CONTRIBUTING.md)).
- The discussion happens in that issue or pull request, in public, so that anyone can follow it and
  take part.
- The maintainer decides: merges the pull request, asks for changes, or closes it. A decision that
  goes against what someone asked for is explained in the issue or pull request, with the reason.
- A change is merged only when CI passes and the maintainer has reviewed it. The rules for what a
  change needs are in [CONTRIBUTING.md](CONTRIBUTING.md).
- A vulnerability is the exception to discussing in public: it is reported and handled in a private
  security advisory, as [SECURITY.md](SECURITY.md) says, and made public with the advisory once a
  fix is released.
- A disagreement is settled by the maintainer after the discussion. Anyone who disagrees with a
  decision can say so in the same issue or pull request, or open a new issue with new facts.
- Changes to this document go through a pull request, like any other change.

## Roles

| Role | Who holds it today | Tasks |
|---|---|---|
| Maintainer | ale-ehp, alone | Triages issues. Reviews and merges pull requests, Dependabot's included. Keeps README.md, THREAT-MODEL.md and CHANGELOG.md current. Tags releases and approves each staged npm version with two-factor authentication ([CONTRIBUTING.md](CONTRIBUTING.md#releasing)). Acknowledges vulnerability reports within the week that [SECURITY.md](SECURITY.md) promises, prepares the fix and publishes the advisory. Administers the GitHub repository and, as the npm user ale_ehp, the npm package. |
| Contributor | Anyone who opens an issue or a pull request | Follows [CONTRIBUTING.md](CONTRIBUTING.md): a test that fails without the change, the typecheck and the tests passing on Linux and Windows, no runtime dependencies, one change per commit, the documentation updated where behaviour changes. |
| Security reporter | Anyone who finds a vulnerability | Reports it privately through the form that [SECURITY.md](SECURITY.md) links, never in a public issue, with a working reproduction, and keeps it private until the advisory is published. |
| User | Anyone who installs mcpcage | Reports bugs and asks for features in [GitHub issues](https://github.com/ale-ehp/mcpcage/issues), with the output of `mcpcage --version` and `mcpcage doctor`. |
