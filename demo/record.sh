#!/usr/bin/env bash
# Records docs/demo.webp with VHS (`npm run demo:webp`). The demo runs twice in a container: once
# unrecorded to build the images, then recorded with --pace (demo/demo.tape).
#
# Requirements:
# - A Docker daemon reachable at /var/run/docker.sock inside its VM (Docker Desktop, Colima,
#   OrbStack) or on the machine (Docker on Linux). The VHS container gets that socket, so the demo in
#   it builds and starts its cages with the same daemon, and reuses its image cache.
# - On Colima and Docker Desktop, the repository under your home directory: the container sees the
#   repository through a bind mount, and only the home directory is shared with the VM (a path
#   outside it comes up empty in the container).
#
# The video VHS records is kept in demo/.recording/demo.mp4 (not committed). To change only the look
# of the animation, convert that video again instead of recording: in the image built below, which
# makes the committed file, or with an ffmpeg built with libwebp on your machine.
#   docker run --rm -v "$PWD:/vhs" --entrypoint bash mcpcage-vhs demo/crt-webp.sh demo/.recording/demo.mp4 docs/demo.webp
#   bash demo/crt-webp.sh demo/.recording/demo.mp4 docs/demo.webp
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
docker build -t mcpcage-vhs -f demo/vhs.Dockerfile demo
# VHS records /tmp/demo.mp4 in the container; demo/crt-webp.sh gives it the look of a CRT monitor
# and makes the animated WebP (see demo/demo.tape).
docker run --rm -v "$PWD:/vhs" -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash mcpcage-vhs -c '
  set -euo pipefail
  vhs demo/demo.tape
  mkdir -p demo/.recording
  cp /tmp/demo.mp4 demo/.recording/demo.mp4
  bash demo/crt-webp.sh demo/.recording/demo.mp4 docs/demo.webp
'
ls -l docs/demo.webp
