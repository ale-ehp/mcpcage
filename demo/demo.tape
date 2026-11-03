# The demo at the top of the README, about 40 seconds. Record it with `npm run demo:gif`
# (demo/record.sh): VHS runs in a container (demo/vhs.Dockerfile), and the demo inside it builds and
# starts its cages through the host's Docker daemon. VHS writes a video inside the container, and
# record.sh turns it into docs/demo.gif with demo/crt-gif.sh, which shows it on the screen of an old
# CRT television: VHS's own GIF output keeps every frame in memory at once (about 2 GB here), more
# than a 2 GB Docker VM such as Colima's default has.
Output "/tmp/demo.mp4"

Set Shell "bash"
# Monochrome: the VT323 typeface (installed by demo/vhs.Dockerfile), warm white on black, and every
# ANSI colour a shade of that white, so the recording is one hue and carries only brightness: the
# green of the phosphor and the television around it come from demo/crt-gif.sh. The screen of that
# television is about 5:4, so the recording is 5:4 too, with a padding that keeps the first and last
# characters of every row clear of its rounded corners. The font is the largest at which the lines
# of the protect report in scene 3, up to 99 characters, stay whole: at this size the terminal has
# 101 columns and 34 rows, the longer text of scenes 1 and 2 wraps, and all of scene 3 fits.
Set FontFamily "VT323"
Set FontSize 24
Set Width 1140
Set Height 930
Set Padding 50
Set Theme { "name": "monochrome", "background": "#000000", "foreground": "#f2f0e6", "selection": "#3a3934", "cursor": "#f2f0e6", "black": "#2b2a26", "red": "#d9d7cd", "green": "#e3e1d7", "yellow": "#ebe9df", "blue": "#cfcdc4", "magenta": "#d4d2c8", "cyan": "#dedcd2", "white": "#e6e4da", "brightBlack": "#8a887f", "brightRed": "#f2f0e6", "brightGreen": "#f7f5eb", "brightYellow": "#fbf9ef", "brightBlue": "#eceae0", "brightMagenta": "#efede3", "brightCyan": "#f5f3e9", "brightWhite": "#fffdf4" }
Set CursorBlink true
Set TypingSpeed 40ms
Set Framerate 20

# A work directory inside the container, kept between the two runs below.
Env MCPCAGE_DEMO_WORK "/tmp/mcpcage-demo"

# Not recorded: a first run builds every image, pins the tools, poisons the notes server and fills
# the npm lookup cache, so the recorded run is as fast on every machine. The echo adds the exit code,
# so the text waited for cannot match the command line itself. The prompt of VHS is coloured: a
# plain one keeps the screen monochrome.
Hide
Type 'PS1="$ "'
Enter
Type 'node demo/run-demo.mjs > /dev/null 2>&1; echo "WARM-UP DONE ($?)"'
Enter
Wait+Screen@900s /WARM-UP DONE [(][0-9]+[)]/
Type "clear"
Enter
Sleep 1s
Show

Type "node demo/run-demo.mjs --pace"
Sleep 500ms
Enter
Wait+Screen@180s /Delete it when you are done/
Sleep 2s
