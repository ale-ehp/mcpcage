# The image that records docs/demo.gif (demo/record.sh plays demo/demo.tape in it). The official VHS
# image has ffmpeg, ttyd and bash, but no Node.js to run the demo and no docker CLI for the demo to
# build and start its cages: the CLI talks to the host's Docker daemon through the mounted socket.
# VHS is pinned by digest, Node and the docker CLI by version. Only classic Dockerfile features
# (no RUN --mount, no heredocs, no COPY --chmod), so it builds without BuildKit too (Colima, no buildx).
FROM ghcr.io/charmbracelet/vhs@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3
ARG NODE_VERSION=22.23.4
ARG DOCKER_VERSION=29.9.2
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64) node_arch=arm64; docker_arch=aarch64;; amd64) node_arch=x64; docker_arch=x86_64;; *) echo "unsupported $arch"; exit 1;; esac; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_VERSION}.tgz" | tar -xz -C /tmp; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker; \
    node --version && npm --version && docker --version
