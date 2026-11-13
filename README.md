# Node-RED NDI Preview

Node-RED nodes that show NDI® sources on a dashboard: a JPEG still of a source every few seconds, with frame
statistics (`ndi-thumbnail`), and later a live preview (`ndi-live`).

**In development. There is nothing to install yet.**

## What you will need

- **The NDI Runtime, installed by you.** This package contains no NDI code. Download the free NDI Runtime (or NDI
  Tools) from <https://ndi.video> and install it on the computer that runs Node-RED. Without it the nodes say
  "NDI Runtime not installed" and do nothing else.
- Node-RED.

The package has no npm runtime dependencies.

Planned npm name: `@jamezjb/node-red-ndi-preview`.

## Licence

Copyright (c) 2026 James Breedon. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): free for
noncommercial use. Third-party code that is included keeps its own licence and notice, next to that code.

NDI® is a registered trademark of Vizrt NDI AB. This project is not affiliated with, or endorsed by, Vizrt NDI AB;
the name says only what the nodes work with. See <https://ndi.video>.
