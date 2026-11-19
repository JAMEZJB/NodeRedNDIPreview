# Changelog

## 0.2.0

- Verbose logging: a checkbox on both nodes, **Verbose logging (for troubleshooting)**, off by default. When it is
  on, every step is written to Node-RED's log, one line per event with an area in square brackets: settings, the
  NDI helper's start, exit and restarts, each request to it and its answer in milliseconds, where the NDI Runtime
  was found, sources that appeared or went, receivers connecting with their first frame and format changes, each
  still (who asked, the result or the reason there was none) and viewers of the live preview. Repeated lines are
  limited (stills on a timer and repeated failures to one line every 10 seconds, with a count of those left out)
  and frames are summarised, so a busy flow stays readable. No pictures, message contents or credentials
  are logged. With it off, the nodes are as quiet as before.

## 0.1.1 (13 November 2026)

- Example flows for both nodes, under **Import**, **Examples** in Node-RED.
- `ndi-live` sends its message again whenever what it knows about the NDI Runtime changes, so a flow is not left
  showing an old answer: for example when the NDI helper answers late after Node-RED starts, or stops.
  `msg.ndi.error` is now also set when the NDI helper has stopped.

## 0.1.0 (13 November 2026)

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
