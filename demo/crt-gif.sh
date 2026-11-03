#!/usr/bin/env bash
# Makes docs/demo.gif from the video VHS records (demo/demo.tape), with the look of an old
# green-phosphor terminal: a soft glow around the text, scanlines, a curved screen with darker
# edges, a faint flicker, and the putty plastic case of a 1980s monitor around it. Only the look
# changes: every frame shows what the recording shows.
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

# The case of the monitor, drawn once by ffmpeg itself and laid over every frame, with a hole where
# the screen shows through. The screen keeps its size and sits in an opening with rounded corners:
# a bezel of 96 px at the sides and 90 at the top, a chin of 144 below, and a near-black room 12 px
# wide all around, so the picture holds on a light page and on a dark one.
room=12 side=96 top=90 chin=144
W=$((sw + 2 * (room + side)))
H=$((sh + 2 * room + top + chin))
sx=$((room + side))
sy=$((room + top))
# The outline of the case and the opening are boxes with rounded corners, each known by its signed
# distance (negative inside): the same number draws the edge smoothed over one pixel, a band along
# it and the light on that band. box stores the distance from the centre of each pixel in register
# $1, and in $2 which way the nearest side faces (-1 up, 1 down, 0 sideways, in between on a
# corner); $3 and $4 are scratch. A geq expression has ten registers.
box() { # registers: distance, facing, scratch, scratch; centre x, y; half width, height; radius
  echo "st($3,abs(X+0.5-$5)-$(($7 - $9)));st($4,abs(Y+0.5-$6)-$(($8 - $9)));st($1,hypot(max(ld($3),0),max(ld($4),0))+min(max(ld($3),ld($4)),0)-$9);st($2,if(gt(ld($3),0)*gt(ld($4),0),ld($4)/hypot(ld($3),ld($4)),gt(ld($4),ld($3)))*if(gt(Y+0.5,$6),1,-1))"
}
outline=$(box 0 1 8 9 $((W / 2)) $((H / 2)) $((W / 2 - room)) $((H / 2 - room)) 36)
opening=$(box 2 3 8 9 $((sx + sw / 2)) $((sy + sh / 2)) $((sw / 2)) $((sh / 2)) 18)
# The plastic is drawn in gray and tinted putty afterwards, one hue like the screen. The light comes
# from above: the front is lighter at the top than at the bottom; the rim, 14 px where the case
# turns away along its outline, is lighter on top, darker at the sides and darkest below; the
# recess, 24 px where the plastic slopes down to the glass, is in shadow at the top, lit at the
# bottom and darker the deeper it goes, and ends in a dark gap 5 px wide around the glass.
gap=5 slope=24
front="(214-22*Y/$H)"
rim="clip((ld(0)+14)/14,0,1)*(if(lt(ld(1),0),-20*ld(1),-40*ld(1))-12*(1-abs(ld(1))))"
recess="((160+42*ld(3))*(0.70+0.30*clip((ld(2)-$gap)/$slope,0,1)))"
# On the chin: ten vent slots on the left, dark inside with a lighter lower lip, and on the right
# the power LED, drawn in colour below.
chin_y=$(((sy + sh + gap + slope + H - room - 14) / 2))
vent_x=$((sx + 30))
led_x=$((sx + sw - 30))
slot="st(4,if(between(X+0.5,$vent_x,$((vent_x + 140))),hypot(mod(X+0.5-$vent_x,14)-7,max(abs(Y+0.5-$chin_y)-15,0))-3.5,99))"
vents="clip(0.5-ld(4),0,1)*(110-40*clip((Y+0.5-$chin_y+18)/36,0,1))"
plastic="$outline;$opening;$slot;st(5,22+($recess-22)*clip(ld(2)-$gap+0.5,0,1));st(5,ld(5)+($front+$rim-$vents-ld(5))*clip(ld(2)-$((gap + slope))+0.5,0,1));13+(ld(5)-13)*clip(0.5-ld(0),0,1)"
hole="$opening;255*clip(ld(2)+0.5,0,1)"
# The LED: a lens of the same green as the phosphor, with a hot core, in a dark socket, and its
# glow on the plastic around it.
led="st(0,hypot(X+0.5-$led_x,Y+0.5-$chin_y));st(1,0.5*pow(clip(1-(ld(0)-6)/22,0,1),2));st(2,clip(7.5-ld(0),0,1));st(3,clip(6-ld(0),0,1));st(4,clip(3-ld(0),0,1))"
led_channel() { # the plastic, then the glow, the socket, the lens and the core in this channel
  echo "$led;st(5,$1+($2-$1)*ld(1));st(5,ld(5)+($3-ld(5))*ld(2));st(5,ld(5)+($4-ld(5))*ld(3));ld(5)+($5-ld(5))*ld(4)"
}
ffmpeg -v error -f lavfi -i "color=black:s=${W}x${H},format=gray" -filter_complex "[0:v]split[p][h];
[p]geq=lum='$plastic',format=gbrp,colorchannelmixer=rr=1:gg=0.96:bb=0.86,
geq=r='$(led_channel 'r(X,Y)' 56 40 56 200)':g='$(led_channel 'g(X,Y)' 255 38 255 255)':b='$(led_channel 'b(X,Y)' 77 34 77 205)'[c];
[h]geq=lum='$hole'[a];
[c][a]alphamerge,format=rgba" -frames:v 1 "$work/case.png"

# In order: 20 frames a second, the rate VHS captures at (Set Framerate in the tape); the curve;
# gray, so the screen stays monochrome; a tight and a wide glow; darker corners; the screen; the
# scanlines; the flicker; the green of the phosphor; the case, last. A GIF stores only what changes
# between frames, and an effect that changes every frame (grain, a steady flicker) makes it tens of
# megabytes. So the flicker dims the text by 4% for two frames now and then, at two unrelated
# rhythms, and leaves the dark screen as it is (values up to 12 round back to themselves); the
# vignette does not dither, because its dithering is random on every frame; and every effect runs
# on the screen before the case goes over it, so the case is the same in every frame and is stored
# once. The case, like the screen and the scanlines, is one image looped without end: overlay and
# blend stop with the video only with shortest=1.
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
format=rgb24,colorchannelmixer=rr=0.22:gg=1:bb=0.30,
pad=$W:$H:$sx:$sy[crt];
[crt][3:v]overlay=format=rgb:shortest=1"

# Two passes that read one frame at a time: the palette first, then the frames. The palette counts
# every pixel of every frame (stats_mode=full), not only the pixels that change (diff): counted only
# where it changes, the case weighs one frame against hundreds of frames of text and gets too few of
# the 256 colours, so the shading of the plastic falls into steps of the wrong hue and the glow of
# the LED into blotches. Counted in every frame, the case keeps its own colours and the green of the
# screen, one hue from black to bright, still gets more than a hundred. The GIF comes out smaller.
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/case.png" -filter_complex "$look,palettegen=stats_mode=full" "$work/palette.png"
ffmpeg -v error -y -i "$input" -loop 1 -i "$work/screen.png" -loop 1 -i "$work/scanlines.png" -loop 1 -i "$work/case.png" -i "$work/palette.png" -filter_complex "$look[crt];[crt][4:v]paletteuse=dither=none:diff_mode=rectangle" "$output"
