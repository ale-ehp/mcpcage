#!/usr/bin/env bash
# Makes docs/demo.gif from the video VHS records (demo/demo.tape), with the look of an old
# white-phosphor CRT monitor: a soft glow around the text, scanlines, a curved screen with darker
# edges, a faint flicker and a warm white. Only the look changes: every frame shows what the
# recording shows.
#   bash demo/crt-gif.sh <input.mp4> <output.gif>
# demo/record.sh runs it in the VHS container after recording. It runs with ffmpeg on the host too,
# to tune the look on demo/.recording/demo.mp4 without recording again.
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "usage: $0 <input.mp4> <output.gif>" >&2
  exit 2
fi
input=$1
output=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$input")
# The curve of the glass. It runs on YUV frames: lenscorrection fills the corners it uncovers with
# the black of limited-range video (16), which is black only before the conversion to full-range
# gray.
curve="lenscorrection=k1=0.04:k2=0.02:i=bilinear"

# Drawn once at the size of the video, laid over every frame: the screen, the area the curve leaves,
# a flat dark gray that fades into the black around it (a gradient this dark shows rings in a GIF);
# the scanlines, one row in three darker.
ffmpeg -v error -f lavfi -i "color=white:s=$size" -vf "format=yuv420p,$curve,format=gray,gblur=sigma=16,lut=c0='val*12/255'" -frames:v 1 "$work/screen.png"
ffmpeg -v error -f lavfi -i "color=white:s=$size,format=gray" -vf "geq=lum='if(mod(Y,3),255,150)'" -frames:v 1 "$work/scanlines.png"

# In order: 20 frames a second, the rate VHS captures at (Set Framerate in the tape); the curve;
# gray, so the screen stays monochrome; a tight and a wide glow; darker corners; the screen; the
# scanlines; the flicker; the warm white, last. A GIF stores only what changes between frames, and
# an effect that changes every frame (grain, a steady flicker) makes it tens of megabytes. So the
# flicker dims the text by 4% for two frames now and then, at two unrelated rhythms, and leaves the
# dark screen as it is (values up to 12 round back to themselves); and the vignette does not dither,
# because its dithering is random on every frame.
look="[0:v]fps=20,format=yuv420p,$curve,format=gray,split=3[text][near][far];
[near]gblur=sigma=2[near];
[far]gblur=sigma=12[far];
[text][near]blend=all_mode=screen:all_opacity=0.5[lit];
[lit][far]blend=all_mode=screen:all_opacity=0.7,vignette=angle=PI/5:dither=0[glow];
[1:v]format=gray[screen];
[glow][screen]blend=all_mode=addition:shortest=1[shown];
[2:v]format=gray[lines];
[shown][lines]blend=all_mode=multiply:shortest=1,
lut=c0='floor(val*0.96+0.5)':enable='between(mod(n,93),61,62)+between(mod(n,137),40,41)',
format=rgb24,colorchannelmixer=rr=1.08:gg=1.06:bb=0.98"

# Two passes that read one frame at a time: the palette first, then the frames.
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -filter_complex "$look,palettegen=stats_mode=diff" "$work/palette.png"
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -i "$work/palette.png" -filter_complex "$look[crt];[crt][3:v]paletteuse=dither=none:diff_mode=rectangle" "$output"
