# Vendored code

| file | from | version | licence | changes |
|---|---|---|---|---|
| `jpeg-encoder.js` | jpeg-js `lib/encoder.js` (<https://github.com/jpeg-js/jpeg-js>), itself Andreas Ritter's JavaScript port of Adobe's ActionScript 3 JPEG encoder | 0.4.4 (npm `jpeg-js@0.4.4`, integrity `sha512-WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==`) | BSD-3-Clause (Eugene Ware, `jpeg-js.LICENSE`) and BSD (Adobe Systems, in the file's header) | none: byte-identical to the published file, sha256 `00bde8df2517eca556669ab6fc27b414e9ba3fc52a0a71e1e37ec7c5f19c3d34` |
| `jpeg-js.LICENSE` | jpeg-js `LICENSE` | 0.4.4 | | none: byte-identical, sha256 `c0a8512eabe960492fefd4f287523eb3b5ca1518ca37ef0ec83344cd7f089cb8` |

The encoder is vendored rather than depended on, so the package has no npm runtime dependencies. It has no
dependencies of its own and is only ever called with RGBA buffers this package builds itself.

To check it: `npm pack jpeg-js@0.4.4`, unpack, and compare the sha256 of `package/lib/encoder.js` and
`package/LICENSE` with the values above.
