# Node-RED NDI Preview

Node-RED nodes that show NDI® sources:

- **`ndi-thumbnail`**: a JPEG still of a source every few seconds (or on each message), with frame statistics.
- **`ndi-live`**: a silent, low-latency live preview of a source that any browser can show, for checking a picture.

NDI® is a registered trademark of Vizrt NDI AB. This project is not affiliated with or endorsed by Vizrt NDI AB;
"NDI" in its name says only what the nodes work with. More about NDI: <https://ndi.video/>.

**Not published yet.** Planned npm name: `@jamezjb/node-red-ndi-preview`.

## What you need

- **The NDI Runtime, installed by you, on the computer that runs Node-RED.** This package contains no NDI code.
  Download the free NDI 6 Runtime, or NDI Tools (which includes it), from <https://ndi.video/tools/>, install it,
  then restart Node-RED. Without it, the nodes say "NDI Runtime not installed (see ndi.video)" and do nothing
  else. NDI 5 and 6 runtimes work; NDI 6 is recommended.
- **macOS** (11 or later, Apple silicon or Intel) or **Windows x64** (10 or 11). Other systems are not supported:
  the nodes load, and say so.
- Node-RED 3.1 or later, on Node.js 18 or later.

The package has no npm dependencies.

## The nodes

### ndi-thumbnail

Pick a source by name ("Find sources" lists what the Node-RED computer can see) or give its `ip:port`. Every *N*
seconds, or whenever a message arrives, it sends:

- `msg.payload`: the JPEG (a Buffer), `msg.statusCode` 200 and `msg.headers['content-type']` `image/jpeg`, the same
  shape as an http request node's reply, so it can feed flows built for a camera's still-image URL;
- `msg.ndi`: `{source, width, height, fps, fourCC, bandwidth, lastFrame, runtime, thumbWidth, thumbHeight, bytes,
  grabMs, connections, framesTotal, framesDropped, connectedForMs}`.

When no picture arrives it sends `payload: null` with `msg.ndi.error`, and warns once per outage. Send `"stop"` (or
`false`) to pause and disconnect, and `"start"` (or `true`) to resume. `msg.source` / `msg.address` override the
configured source for one message.

### ndi-live

Serves the source as Motion-JPEG on Node-RED's HTTP node server (the same place as *http in* nodes):

- `<httpNodeRoot>/ndi-live/<node id>.mjpg`: the live picture; show it with `<img src="…">` in any browser or
  dashboard template;
- `<httpNodeRoot>/ndi-live/<node id>.jpg`: one still.

It sends the path once when the flow starts and in reply to every message. Defaults: 10 frames a second (at most
15), 640 pixels wide, at most 4 viewers. It is a preview, not a programme monitor: no sound, a fraction of a second
behind live.

The connection to the source opens when the first viewer starts watching and closes a few seconds after the last
one stops, so an unwatched preview uses no network and no processor time. Each frame is encoded once for all
viewers, and a viewer on a slow connection skips frames instead of falling behind. Send `"stop"` to end every
viewer and refuse new ones, `"start"` to allow them again.

**Who can watch:** the endpoints sit behind Node-RED's `httpNodeAuth` if your settings set it. Without it, anyone
who can reach Node-RED's HTTP endpoints can watch.

### Both nodes

- **Network use.** *Proxy* (the default) asks the sender for its low-bandwidth stream. *Full* asks for the full
  stream, which can be over 100 Mb/s per camera.
- **One connection per source.** Nodes that show the same source share one NDI connection to it.
- **Tally is never set**, so a preview never lights a camera's on-air lamp.
- **Safe for Node-RED.** All NDI work runs in a separate helper process. If the NDI Runtime crashes or hangs, the
  helper is restarted (with a pause that grows each time), and Node-RED keeps running. After five crashes in a
  minute it stops trying and the nodes say so, until Node-RED is restarted.
- **Where the runtime is found.** On Windows, the folder the NDI 6 Runtime installer records in
  `NDI_RUNTIME_DIR_V6`; on macOS, `/usr/local/lib/libndi.dylib`. To use a runtime somewhere else, set
  `NDI_PREVIEW_RUNTIME` to the full path of the library before starting Node-RED.
- **Windows firewall.** The helper asks the NDI Runtime to receive over TCP, which a firewall without an allow rule
  for Node-RED does not block. Your own NDI settings (groups, discovery server, extra IPs) still apply. If you set
  `NDI_CONFIG_DIR` yourself, your configuration is used unchanged.

## Building from source

The add-on is a small C file (`native/ndi_preview.c`) using Node-API. It loads the NDI Runtime the user installed
at run time and links no NDI library. Building it needs the NDI SDK's header files: install the NDI SDK from
<https://ndi.video/> (it is not part of this repository).

- macOS: `npm run build` (needs the Xcode Command Line Tools; set `NDI_SDK_DIR` if the SDK is not in
  `/Library/NDI SDK for Apple`).
- Windows x64: `native/build-win.ps1` (needs the Visual Studio C++ build tools with the Windows SDK, and the NDI SDK
  for Windows).

Tests: `npm test` runs the unit tests with a synthetic stand-in for NDI, so it needs no NDI and no network.
`npm run check` also checks the add-on and the package contents and, on macOS, runs an end-to-end test against a
local test source. That test runs every NDI process in a macOS sandbox that only allows loopback traffic.

## Licence

Copyright (c) 2026 James Breedon. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): free for
noncommercial use.

Third-party code and terms are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), including the terms that
apply to the NDI software this package works with.
