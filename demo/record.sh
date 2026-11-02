#!/usr/bin/env bash
# Records docs/demo.gif with VHS (`npm run demo:gif`). The demo runs twice in a container: once
# unrecorded to build the images, then recorded with --pace (demo/demo.tape).
#
# Requirements:
# - A Docker daemon reachable at /var/run/docker.sock inside its VM (Docker Desktop, Colima,
#   OrbStack) or on the machine (Docker on Linux). The VHS container gets that socket, so the demo in
#   it builds and starts its cages with the same daemon, and reuses its image cache.
# - On Colima and Docker Desktop, the repository under your home directory: the container sees the
#   repository through a bind mount, and only the home directory is shared with the VM (a path
#   outside it comes up empty in the container).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
docker build -t mcpcage-vhs -f demo/vhs.Dockerfile demo
# VHS records /tmp/demo.mp4 in the container; ffmpeg makes the GIF from it in two passes that read
# one frame at a time: the palette first, then the frames (see demo/demo.tape).
docker run --rm -v "$PWD:/vhs" -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash mcpcage-vhs -c '
  set -euo pipefail
  vhs demo/demo.tape
  ffmpeg -v error -y -i /tmp/demo.mp4 -vf palettegen /tmp/palette.png
  ffmpeg -v error -y -i /tmp/demo.mp4 -i /tmp/palette.png -filter_complex "[0:v][1:v]paletteuse=dither=none" docs/demo.gif
'
ls -l docs/demo.gif
