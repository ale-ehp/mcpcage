# The image that records docs/demo.webp (demo/record.sh plays demo/demo.tape in it). The official VHS
# image has ffmpeg, ttyd and bash, but no Node.js to run the demo, no docker CLI for the demo to
# build and start its cages (the CLI talks to the host's Docker daemon through the mounted socket),
# and not the typeface of the recording: VT323 by Peter Hull, under the SIL Open Font License 1.1,
# made from the glyphs of the DEC VT320 text terminal.
# VHS is pinned by digest; Node is checked against the SHASUMS256.txt published next to it; VT323
# comes from the google/fonts repository at the commit that last changed it, checked against the
# SHA-256 written below; the docker CLI is pinned by version only, because Docker publishes no
# checksums for its static builds. Only classic Dockerfile features (no RUN --mount, no heredocs, no
# COPY --chmod), so it builds without BuildKit too (Colima, no buildx).
FROM ghcr.io/charmbracelet/vhs@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3
ARG NODE_VERSION=22.23.4
ARG DOCKER_VERSION=29.9.2
ARG VT323_COMMIT=eb8781e516576b414603df8cd267c0f21c9b4ee2
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in arm64) node_arch=arm64; docker_arch=aarch64;; amd64) node_arch=x64; docker_arch=x86_64;; *) echo "unsupported $arch"; exit 1;; esac; \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " node-v${NODE_VERSION}-linux-${node_arch}.tar.xz$" | sha256sum -c -; \
    tar -xJ -C /usr/local --strip-components=1 -f "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" && rm "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_VERSION}.tgz" | tar -xz -C /tmp; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker; \
    mkdir -p /usr/share/fonts/truetype/vt323; \
    curl -fsSL -o /usr/share/fonts/truetype/vt323/VT323-Regular.ttf "https://raw.githubusercontent.com/google/fonts/${VT323_COMMIT}/ofl/vt323/VT323-Regular.ttf"; \
    echo "cf4de751ada78ceac033dbe16a687742939995b77bc2a052ae17a4957958594d  /usr/share/fonts/truetype/vt323/VT323-Regular.ttf" | sha256sum -c -; \
    fc-cache -f; \
    fc-list : family | grep -qx VT323; \
    node --version && npm --version && docker --version
