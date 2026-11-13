# Third-party notices

## NDI®

NDI® is a registered trademark of Vizrt NDI AB. More about NDI: <https://ndi.video/>.

This package contains no NDI software. It works with the NDI Runtime that you download from <https://ndi.video/>
and install yourself, and its add-on was built using the NDI SDK's header files. The NDI Runtime and the NDI SDK are
licensed by Vizrt NDI AB under their own terms, which you accept when you install them. When you use this package
with NDI software, these terms also apply to you:

- You may not modify the NDI SDK, the NDI Runtime or any other NDI product, or any part of them.
- You may not reverse engineer, disassemble or recompile the NDI SDK, the NDI Runtime or any other NDI product, or
  any protocol they use (whether sent or received over a network, or used inside a computer), and you may not try to.
- You may not circumvent any technical limitation in the NDI SDK, the NDI Runtime or any other NDI product.
- You may not remove, obscure or alter any proprietary notice or label in the NDI SDK, the NDI Runtime or any other
  NDI product.
- Vizrt NDI AB and its licensors give no warranty of any kind for their software, and, as far as the law allows,
  they are not liable for any damages (direct, indirect, incidental or consequential) arising from the use of this
  package with their software.
- You must comply with all relevant export laws and regulations of the United States, so that NDI software is not
  exported, directly or indirectly, in breach of United States law.
- The NDI SDK and NDI Runtime are copyright Vizrt NDI AB. All rights reserved.
- If you use this package to develop products of your own that use NDI, those products must comply with the NDI SDK
  License Agreement, including its requirement of current and complete NDI compatibility, and their end-user licence
  must include these terms.

The NDI SDK License Agreement: <https://ndi.link/ndisdk_license>.

Formats such as H.264, H.265 and AAC (used by some NDI|HX sources) may need licences of their own. The NDI Runtime
decodes them; making sure that use is licensed is your responsibility.

## jpeg-js encoder

`lib/vendor/jpeg-encoder.js` is the JPEG encoder from jpeg-js 0.4.4 (<https://github.com/jpeg-js/jpeg-js>),
unchanged. Provenance: `lib/vendor/PROVENANCE.md`.

jpeg-js licence (`lib/vendor/jpeg-js.LICENSE`):

```
Copyright (c) 2014, Eugene Ware
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of Eugene Ware nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY EUGENE WARE ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

The encoder is itself a port of Adobe's ActionScript 3 JPEG encoder. Its licence, from the header of
`lib/vendor/jpeg-encoder.js`:

```
Copyright (c) 2008, Adobe Systems Incorporated
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.

* Neither the name of Adobe Systems Incorporated nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Node.js

The add-on is compiled against Node.js's Node-API header files (MIT licence, Copyright Node.js contributors). No
Node.js code is included in this package.
