# Base images mcpcage builds caged servers from, pinned by digest. mcpcage reads the FROM lines
# below at build time; keeping them in a Dockerfile lets Dependabot propose digest updates.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS install
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
# PyPI servers (uvx). The resolve image runs `uv pip compile` (it needs an interpreter to query, which
# the distroless uv image cannot even look for); the uv image gives the install stage its uv binary,
# the same release; the install stage is the runtime's base as root, so the Python and the wheels
# are put together against the C library they run on; the runtime has no shell and runs as 65532.
FROM ghcr.io/astral-sh/uv:0.13.7-python3.13-trixie-slim@sha256:6ff812e34a0e14b4b8bc9ddf25e77b3e16bac6e0c4d9b67641f40366fa382d4c AS pypi-resolve
FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS pypi-uv
FROM gcr.io/distroless/cc-debian13:latest@sha256:e1f5543d45a2cd7c02a5b43dda5f0ff30729b4832113759d01ed39b0b152cddb AS pypi-install
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab AS pypi-runtime
