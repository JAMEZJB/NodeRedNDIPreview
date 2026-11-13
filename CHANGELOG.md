# Changelog

## 0.1.0 (not released yet)

First version.

- `ndi-thumbnail`: a JPEG still of an NDI® source every few seconds or on each message, with frame statistics.
  The message has the same shape as an http request node's reply.
- `ndi-live`: a live Motion-JPEG preview at `<httpNodeRoot>/ndi-live/<node id>.mjpg` (and one still at `.jpg`).
  It receives only while someone is watching, encodes each frame once for all viewers, and limits the number of
  viewers.
- All NDI work runs in a separate helper process, which is restarted if it crashes or hangs, so Node-RED keeps
  running. Nodes that show the same source share one connection to it. Tally is never set.
- Uses the NDI Runtime the user installs (NDI 5 or 6); contains no NDI code. Without the runtime the nodes say
  "NDI Runtime not installed (see ndi.video)" and do nothing else.
- macOS (universal) and Windows x64. No npm dependencies.
