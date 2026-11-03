#!/usr/bin/env bash
# Makes docs/demo.gif from the video VHS records (demo/demo.tape), with the look of an old
# green-phosphor terminal: a glow around the text, scanlines, a curved screen with darker edges and
# a faint flicker, inside the screen of a real television. Only the look changes: every frame shows
# what the recording shows.
#   bash demo/crt-gif.sh <input.mp4> <output.gif>
# The television is demo/crt-frame.png: a photo of a JCPenney RGB Monitor/Receiver, a CRT television
# of the 1980s, from a PNG cut-out found on the web, with the screen and the background made
# transparent.
# demo/record.sh runs this script in the VHS container after recording. It runs with ffmpeg on the
# host too, to tune the look on demo/.recording/demo.mp4 without recording again.
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "usage: $0 <input.mp4> <output.gif>" >&2
  exit 2
fi
input=$1
output=$2
frame="$(dirname "$0")/crt-frame.png"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$input")
sw=${size%x*}
sh=${size#*x}
# The curve of the glass. It runs on YUV frames: lenscorrection fills the corners it uncovers with
# the black of limited-range video (16), which is black only before the conversion to full-range
# gray.
curve="lenscorrection=k1=0.04:k2=0.02:i=bilinear"

# Drawn once at the size of the video, laid over every frame: the screen, the area the curve leaves,
# a flat dark gray that fades into the black around it (a gradient this dark shows rings in a GIF);
# the scanlines, one row in three darker.
ffmpeg -v error -f lavfi -i "color=white:s=$size" -vf "format=yuv420p,$curve,format=gray,gblur=sigma=16,lut=c0='val*12/255'" -frames:v 1 "$work/screen.png"
ffmpeg -v error -f lavfi -i "color=white:s=$size,format=gray" -vf "geq=lum='if(mod(Y,3),255,150)'" -frames:v 1 "$work/scanlines.png"

# The television, scaled once and laid over every frame. The hole of its screen in
# demo/crt-frame.png (800x815) has the bounding box x 93, y 80, 614x496: about 5:4, which is why the
# tape records at 1080x880. The hole has the bulged outline of a picture tube: only its middle rows
# reach the full width and only its middle columns the full height, and its corners are long curves.
# The photo is scaled so that the box comes out 20 px narrower than the video, and the video is
# centred on it. The bezel then covers the black the curve leaves around the picture, except about
# 5 px at the middle of the left and right sides (the curve pulls them in by 15), where the screen
# fades out and still shows as dark glass; and the padding of the tape keeps the first and last
# characters of every row clear of the corners. Around the photo, a near-black room 12 px wide, so
# the picture holds on a light page and on a dark one.
read -r fw fh vx vy <<<"$(awk -v w="$sw" -v h="$sh" 'BEGIN { k = (w - 20) / 614; printf "%d %d %d %d\n", 800 * k + 0.5, 815 * k + 0.5, (93 + 614 / 2) * k - w / 2 + 0.5, (80 + 496 / 2) * k - h / 2 + 0.5 }')"
room=12
# Under its transparent pixels the cut-out keeps the white background of the photo, which scaling
# would blend into every edge as a light fringe; and it leaves a seam of that background, 3 or 4 px
# wide, along the left and right sides of the television, and a few specks above it. So, before
# scaling: within 20 px of the border of the photo (the hole is far from it), a pixel stays opaque
# only if the 4 px on its left and the 4 on its right are opaque too; then every transparent pixel
# takes the colour of the room.
span=$(printf '+alpha(X%+d,Y)' -4 -3 -2 -1 0 1 2 3 4)
ffmpeg -v error -i "$frame" -vf "format=rgba,
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,20,W-21)*between(Y,20,H-21),alpha(X,Y),255*eq($span,9*255))',
geq=r='if(alpha(X,Y),r(X,Y),13)':g='if(alpha(X,Y),g(X,Y),12)':b='if(alpha(X,Y),b(X,Y),11)':a='alpha(X,Y)',
scale=$fw:$fh:flags=lanczos" -frames:v 1 "$work/tv.png"

# In order: 20 frames a second, the rate VHS captures at (Set Framerate in the tape); the curve;
# gray, so the screen stays monochrome; a near and a far glow, both at full strength (a screen blend
# lights the dark around the strokes and leaves the strokes, already bright, almost as they are, so
# the text blooms and stays sharp); darker corners; the screen; the scanlines; the flicker; the
# green of the phosphor; then the room around the screen and the television over it, last. A GIF
# stores only what changes between frames, and an effect that changes every frame (grain, a steady
# flicker) makes it tens of megabytes. So the flicker dims the text by 4% for two frames now and
# then, at two unrelated rhythms, and leaves the dark screen as it is (values up to 12 round back to
# themselves); the vignette does not dither, because its dithering is random on every frame; and
# every effect runs on the screen before the television goes over it, so the television is the same
# in every frame and is stored once. The television, like the screen and the scanlines, is one image
# looped without end: overlay and blend stop with the video only with shortest=1.
look="[0:v]fps=20,format=yuv420p,$curve,format=gray,split=3[text][near][far];
[near]gblur=sigma=3[near];
[far]gblur=sigma=16[far];
[text][near]blend=all_mode=screen:all_opacity=1[lit];
[lit][far]blend=all_mode=screen:all_opacity=1,vignette=angle=PI/5:dither=0[glow];
[1:v]format=gray[screen];
[glow][screen]blend=all_mode=addition:shortest=1[shown];
[2:v]format=gray[lines];
[shown][lines]blend=all_mode=multiply:shortest=1,
lut=c0='floor(val*0.96+0.5)':enable='between(mod(n,93),61,62)+between(mod(n,137),40,41)',
format=rgb24,colorchannelmixer=rr=0.22:gg=1:bb=0.30,
pad=$((fw + 2 * room)):$((fh + 2 * room)):$((room + vx)):$((room + vy)):color=0x0d0c0b[crt];
[crt][3:v]overlay=$room:$room:format=rgb:shortest=1"

# Two passes that read one frame at a time: the palette first, then the frames. The palette counts
# every pixel of every frame (stats_mode=full), not only the pixels that change (diff). Counted in
# every frame, the photo of the television takes about 200 of the 256 colours and the green of the
# screen, one hue from black to bright, about 50, in steps of two or three levels where the glow
# fades into the glass; counted only where it changes, the green gets about 90 and the photo looks
# the same, but the GIF comes out 40% larger.
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/tv.png" -filter_complex "$look,palettegen=stats_mode=full" "$work/palette.png"
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/tv.png" -i "$work/palette.png" -filter_complex "$look[crt];[crt][4:v]paletteuse=dither=none:diff_mode=rectangle" "$output"
