# Base images mcpcage builds caged servers from, pinned by digest. mcpcage reads the two FROM lines
# below at build time; keeping them in a Dockerfile lets Dependabot propose digest updates.
FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS install
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime
