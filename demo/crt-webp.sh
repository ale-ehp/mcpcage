#!/usr/bin/env bash
# Makes docs/demo.webp from the video VHS records (demo/demo.tape), with the look of an old
# green-phosphor terminal: a glow around the text, scanlines, a curved screen with darker edges and
# a faint flicker, inside the screen of a real television, on a transparent background. Only the
# look changes: every frame shows what the recording shows.
#   bash demo/crt-webp.sh <input.mp4> <output.webp>
# The television is demo/crt-frame.png: a photo of a JCPenney RGB Monitor/Receiver, a CRT television
# of the 1980s, prepared once from a PNG cut-out found on the web: cropped to the television, its
# screen and the background made transparent with a soft edge, the outline of its screen
# straightened, and the brand label painted over.
# The output is a lossless animated WebP, not a GIF. A GIF has 256 colours in all and a pixel that is
# either opaque or transparent: the soft edges of the television came out as stairs on the page and
# the green of the screen had about 140 levels. The WebP keeps every colour and 256 levels of
# transparency, every browser since 2020 plays it, GitHub shows it in the README, and it comes out
# smaller (about 3.3 MB against 4.1 MB).
# demo/record.sh runs this script in the VHS container after recording. It runs on the host too,
# with an ffmpeg built with libwebp, to tune the look on demo/.recording/demo.mp4 without recording
# again.
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "usage: $0 <input.mp4> <output.webp>" >&2
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
# gray. Drawn on frames twice the size of the video and scaled back, it leaves the edges of the
# letters only 2% sharper, too little to see, and takes twice as long.
curve="lenscorrection=k1=0.04:k2=0.02:i=bilinear"

# Drawn once at the size of the video, laid over every frame: the screen, the area the curve leaves,
# a flat dark gray that fades into the black around it; the scanlines, one row in three darker, but
# not so dark that they cut the letters in strips.
ffmpeg -v error -f lavfi -i "color=white:s=$size" -vf "format=yuv420p,$curve,format=gray,gblur=sigma=16,lut=c0='val*12/255'" -frames:v 1 "$work/screen.png"
ffmpeg -v error -f lavfi -i "color=white:s=$size,format=gray" -vf "geq=lum='if(mod(Y,3),255,185)'" -frames:v 1 "$work/scanlines.png"

# The television, scaled once and laid over every frame. The hole of its screen in
# demo/crt-frame.png (800x815) has the bounding box x 93, y 80, 615x497: about 5:4, which is why the
# tape records at 1140x930. The photo is scaled so that the box comes out 40 px narrower than the
# video, and the video is centred on it: the bezel covers 20 px of the picture on every side, more
# than the curve pulls in the middle of the left and right sides (16 px), so no black shows between
# the picture and the bezel; and the padding of the tape keeps the first and last characters of
# every row clear of the rounded corners of the hole.
read -r fw fh vx vy <<<"$(awk -v w="$sw" -v h="$sh" 'BEGIN { k = (w - 40) / 615; printf "%d %d %d %d\n", 800 * k + 0.5, 815 * k + 0.5, (93 + 615 / 2) * k - w / 2 + 0.5, (80 + 497 / 2) * k - h / 2 + 0.5 }')"
# The colours of the photo are made coarser once, because a lossless WebP stores every distinct
# colour and a photo has tens of thousands: gray in steps of 8 (the grain of the plastic hides the
# steps) and colour in steps of 24 around the warm gray of the plastic (U 126, V 130 in YUV),
# rounded so that the reds of the logo keep their hue. About 140 colours. The alpha stays as it is:
# soft around the television and around the hole of its screen.
ffmpeg -v error -i "$frame" -vf "format=rgba,scale=$fw:$fh:flags=lanczos,format=yuva444p,
lutyuv=y='trunc(val/8)*8+4':u='round((val-126)/24)*24+126':v='round((val-130)/24)*24+130',format=rgba" -frames:v 1 "$work/tv.png"

# In order: 20 frames a second, the rate VHS captures at (Set Framerate in the tape); the curve;
# gray, so the screen stays monochrome; a wide glow, brightened, which shows only where it is
# brighter than the text (lighten), so it lights the dark around the strokes and leaves the strokes
# as thin and sharp as they are (a narrow glow, or a screen blend, makes them thick and soft);
# darker corners; the screen; the scanlines; the flicker; the green of the phosphor; then the
# frame padded with transparency to the size of the television, and the television over it, last.
# An animated WebP, like a GIF, stores only the rectangle that changes between frames, and an
# effect that changes every frame (grain, a steady flicker) makes it tens of megabytes. So the
# flicker dims the letters by 4% for two frames now and then, at two unrelated rhythms, and leaves
# the dark screen and the glow as they are: it fades out below 100 and stops at 40, so that only the
# letters are stored again, not the whole screen. The vignette does not dither, because its
# dithering is random on every frame; and every effect runs on the screen before the television
# goes over it, so the television is the same in every frame and is stored once. The television,
# like the screen and the scanlines, is one image looped without end: overlay and blend stop with
# the video only with shortest=1.
look="[0:v]fps=20,format=yuv420p,$curve,format=gray,split[text][glow];
[glow]gblur=sigma=18,lut=c0='val*1.6'[glow];
[text][glow]blend=all_mode=lighten,vignette=angle=PI/5:dither=0[lit];
[1:v]format=gray[screen];
[lit][screen]blend=all_mode=addition:shortest=1[shown];
[2:v]format=gray[lines];
[shown][lines]blend=all_mode=multiply:shortest=1,
lut=c0='floor(val-0.04*val*clip((val-40)/60,0,1)+0.5)':enable='between(mod(n,93),61,62)+between(mod(n,137),40,41)',
format=rgb24,colorchannelmixer=rr=0.22:gg=1:bb=0.30,format=rgba,
pad=$fw:$fh:$vx:$vy:color=black@0[crt];
[crt][3:v]overlay=format=rgb:shortest=1,format=rgba"

# One pass, lossless: every frame is exactly what the chain gives, so the letters stay as sharp as
# the chain leaves them. libwebp stores each frame as the rectangle that changed, and a frame equal
# to the one before only lengthens the delay of that one. compression_level 6 is its slowest and
# smallest setting; the loop of 0 plays without end.
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/tv.png" -filter_complex "$look" -c:v libwebp_anim -lossless 1 -compression_level 6 -loop 0 "$output"
