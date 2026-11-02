# The 30-second demo at the top of the README. Record it with `npm run demo:gif` (demo/record.sh):
# VHS runs in a container (demo/vhs.Dockerfile), and the demo inside it builds and starts its cages
# through the host's Docker daemon. VHS writes a video inside the container, and record.sh turns it
# into docs/demo.gif: VHS's own GIF output keeps every frame in memory at once (about 2 GB here),
# more than a 2 GB Docker VM such as Colima's default has.
Output "/tmp/demo.mp4"

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20

# A work directory inside the container, kept between the two runs below.
Env MCPCAGE_DEMO_WORK "/tmp/mcpcage-demo"

# Not recorded: a first run builds every image, pins the tools, poisons the notes server and fills
# the npm lookup cache, so the recorded run is as fast on every machine. The echo adds the exit code,
# so the text waited for cannot match the command line itself.
Hide
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
Sleep 3s
