# Base images mcpcage builds caged servers from, pinned by digest. mcpcage reads the FROM lines
# below at build time; keeping them in a Dockerfile lets Dependabot propose digest updates.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS install
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
# PyPI servers (uvx). The resolve image runs `uv pip compile` (it needs an interpreter to query, which
# the distroless uv image cannot even look for); the uv image gives the install stage its uv binary,
# the same release; the install stage is the runtime's base as root, so the Python and the wheels
# are put together against the C library they run on; the runtime has no shell and runs as 65532.
FROM ghcr.io/astral-sh/uv:0.13.9-python3.13-trixie-slim@sha256:803d2b80b6913e562837d69f037f39bfea80f51ef3f0dd0d8fdffbd95688fd6d AS pypi-resolve
FROM ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d AS pypi-uv
FROM gcr.io/distroless/cc-debian13:latest@sha256:58e12be899275afaa05f1b03051ab19037ed7f252528e57a3a9ad7e220a62578 AS pypi-install
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1 AS pypi-runtime
