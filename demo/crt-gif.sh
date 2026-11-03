#!/usr/bin/env bash
# Makes docs/demo.gif from the video VHS records (demo/demo.tape), with the look of an old
# green-phosphor terminal: a glow around the text, scanlines, a curved screen with darker edges and
# a faint flicker, inside the screen of a real television, on a transparent background. Only the
# look changes: every frame shows what the recording shows.
#   bash demo/crt-gif.sh <input.mp4> <output.gif>
# The television is demo/crt-frame.png: a photo of a JCPenney RGB Monitor/Receiver, a CRT television
# of the 1980s, prepared once from a PNG cut-out found on the web: cropped to the television, its
# screen and the background made transparent with a soft edge, and the brand label painted over.
# demo/record.sh runs this script in the VHS container after recording. It runs on the host too,
# with ffmpeg and Node.js, to tune the look on demo/.recording/demo.mp4 without recording again.
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
# gray. Drawn on frames twice the size of the video and scaled back, it leaves the edges of the
# letters only 2% sharper, too little to see, and takes twice as long.
curve="lenscorrection=k1=0.04:k2=0.02:i=bilinear"

# Drawn once at the size of the video, laid over every frame: the screen, the area the curve leaves,
# a flat dark gray that fades into the black around it (a gradient this dark shows rings in a GIF);
# the scanlines, one row in three darker, but not so dark that they cut the letters in strips.
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
# The 256 colours of a GIF are shared by the photo and the screen, and a photo takes as many as it
# is given. So its colours are made coarser once: gray in steps of 8 (the grain of the plastic hides
# the steps) and colour in steps of 24 around the warm gray of the plastic (U 126, V 130 in YUV),
# rounded so that the reds of the logo keep their hue: about 140 colours, not tens of thousands. And
# alpha is cut at 128 around the television, because a GIF pixel is either opaque or transparent;
# the soft edge of the hole stays, since the screen shows through it, not the page.
ffmpeg -v error -i "$frame" -vf "format=rgba,scale=$fw:$fh:flags=lanczos,format=yuva444p,
lutyuv=y='trunc(val/8)*8+4':u='round((val-126)/24)*24+126':v='round((val-130)/24)*24+130',format=rgba,
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,$vx,$((vx + sw - 1)))*between(Y,$vy,$((vy + sh - 1))),alpha(X,Y),255*gte(alpha(X,Y),128))'" -frames:v 1 "$work/tv.png"

# In order: 20 frames a second, the rate VHS captures at (Set Framerate in the tape); the curve;
# gray, so the screen stays monochrome; a wide glow, brightened, which shows only where it is
# brighter than the text (lighten), so it lights the dark around the strokes and leaves the strokes
# as thin and sharp as they are (a narrow glow, or a screen blend, makes them thick and soft);
# darker corners; the screen; the scanlines; the flicker; the green of the phosphor; then the
# television over the screen, last, with magenta around it (see the end of this script).
# A GIF stores only what changes between frames, and an effect that changes every frame (grain, a
# steady flicker) makes it tens of megabytes. So the flicker dims the letters by 4% for two frames
# now and then, at two unrelated rhythms, and leaves the dark screen and the glow as they are: it
# fades out below 100 and stops at 40, because dimming the glow too would redraw the whole screen
# twice in every flicker, a third of the size of the GIF. The vignette does not dither, because its
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
format=rgb24,colorchannelmixer=rr=0.22:gg=1:bb=0.30,
pad=$fw:$fh:$vx:$vy:color=0xff00ff[crt];
[crt][3:v]overlay=format=rgb:shortest=1"

# Two passes that read one frame at a time: the palette first, then the frames. The palette counts
# the first frame whole and then only the pixels that change (stats_mode=diff): the television and
# the soft edge of the hole, the same in every frame, count once, and the green of the screen gets
# about 140 levels, in steps of at most 3 in the glow. Counted in every frame (full), the television
# and the edge of the hole take about 170 of the 256 colours and leave the green about 90 levels;
# the GIF comes out a sixth smaller, and the television looks the same either way, but for a few
# pixels of its logo. palettegen keeps its default of one entry for transparency, which the encoder
# gives, in every frame after the first, to the pixels that did not change.
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/tv.png" -filter_complex "$look,palettegen=stats_mode=diff" "$work/palette.png"
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/tv.png" -i "$work/palette.png" -filter_complex "$look[crt];[crt][4:v]paletteuse=dither=none:diff_mode=rectangle" "$output"

# Around the television the page shows through. ffmpeg's GIF encoder stores whole every frame that
# has a transparent pixel, with no difference from the frame before: here, the photo in every frame,
# about 200 megabytes. So up to the encoder the frames are opaque, with magenta (a colour found
# nowhere else in them) where the page should show, and the encoder stores only what changes; then
# the first frame, the only one that draws outside the screen, is marked so that its magenta is
# transparent: the flag and the index of the transparent colour in its graphic control extension.
node --input-type=module - "$output" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const gif = readFileSync(file);
const tableSize = (flags) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
// After the header and the global colour table: the extensions of the first frame, then its image.
let at = 13 + tableSize(gif[10]);
let control = -1;
while (gif[at] === 0x21) {
  if (gif[at + 1] === 0xf9) control = at;
  at += 2;
  while (gif[at]) at += gif[at] + 1;
  at += 1;
}
// Disposal 1: the first frame stays under the next ones (2 would clear it after it is shown).
if (gif[at] !== 0x2c || control < 0 || ((gif[control + 3] >> 2) & 7) !== 1) {
  throw new Error(`${file}: the first frame is not stored as expected`);
}
// The colours of the first frame: its own table if it has one, the global table otherwise.
const own = tableSize(gif[at + 9]);
const colours = own ? at + 10 : 13;
let key = -1;
let nearest = Infinity;
for (let i = 0; i < (own || tableSize(gif[10])) / 3; i++) {
  const [r, g, b] = gif.subarray(colours + 3 * i, colours + 3 * i + 3);
  const distance = (255 - r) ** 2 + g ** 2 + (255 - b) ** 2;
  if (distance < nearest) [key, nearest] = [i, distance];
}
if (nearest > 3 * 16 ** 2) throw new Error(`${file}: no magenta in the colours of the first frame`);
gif[control + 3] |= 1;
gif[control + 6] = key;
writeFileSync(file, gif);
EOF
