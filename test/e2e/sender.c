// TEST-ONLY loopback NDI source (never shipped): scrolling colour bars and a moving white block, BGRX.
//
// It refuses to run unless it is inside a macOS sandbox and NDI_CONFIG_DIR is set: test/e2e/run-mac.sh starts it
// under test/e2e/loopback.sb (outbound network to loopback only) with a loopback-only NDI configuration.
// It loads the NDI Runtime the same way the add-on does: NDI_PREVIEW_RUNTIME (an absolute path), else
// /usr/local/lib/libndi.dylib.
//
// usage: ndi_test_sender [name] [width] [height] [fps]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <stdbool.h>
#include <dlfcn.h>
#include <unistd.h>
#include "Processing.NDI.Lib.h"

// libsystem_sandbox: returns non-zero when the given process runs inside a sandbox.
extern int sandbox_check(pid_t pid, const char* operation, int type, ...);

static volatile sig_atomic_t stop = 0;
static void on_sig(int s) { (void)s; stop = 1; }

int main(int argc, char** argv) {
  if (!sandbox_check(getpid(), NULL, 0)) { fprintf(stderr, "refusing to run outside the loopback sandbox\n"); return 4; }
  if (!getenv("NDI_CONFIG_DIR")) { fprintf(stderr, "refusing to run without NDI_CONFIG_DIR (loopback config)\n"); return 4; }
  const char* name = argc > 1 ? argv[1] : "NDI Preview Test Pattern";
  int W = argc > 2 ? atoi(argv[2]) : 1280, H = argc > 3 ? atoi(argv[3]) : 720, FPS = argc > 4 ? atoi(argv[4]) : 25;
  if (W < 64 || H < 64 || FPS < 1 || FPS > 60) { fprintf(stderr, "bad size or rate\n"); return 2; }
  const char* rt = getenv("NDI_PREVIEW_RUNTIME");
  void* lib = dlopen(rt && *rt ? rt : "/usr/local/lib/libndi.dylib", RTLD_LOCAL | RTLD_LAZY);
  const NDIlib_v6* (*load)(void) = NULL;
  if (lib) { *(void**)&load = dlsym(lib, "NDIlib_v6_load"); if (!load) *(void**)&load = dlsym(lib, "NDIlib_v5_load"); }
  if (!load) { fprintf(stderr, "no NDI 5/6 runtime\n"); return 2; }
  const NDIlib_v6* N = load();
  if (!N || !N->initialize()) { fprintf(stderr, "NDI init failed\n"); return 2; }
  NDIlib_send_create_t sc; memset(&sc, 0, sizeof sc);
  sc.p_ndi_name = name; sc.clock_video = true;
  NDIlib_send_instance_t snd = N->send_create(&sc);
  if (!snd) { fprintf(stderr, "send_create failed (name in use?)\n"); return 3; }
  printf("{\"ready\":true,\"pid\":%d,\"runtime\":\"%s\"}\n", (int)getpid(), N->version()); fflush(stdout);
  signal(SIGINT, on_sig); signal(SIGTERM, on_sig);
  static const unsigned char bars[8][3] = { {192,192,192},{0,192,192},{192,192,0},{0,192,0},{192,0,192},{0,0,192},{192,0,0},{16,16,16} };
  int stride = W * 4;
  unsigned char* buf = malloc((size_t)stride * H);
  if (!buf) return 2;
  NDIlib_video_frame_v2_t f; memset(&f, 0, sizeof f);
  f.xres = W; f.yres = H; f.FourCC = NDIlib_FourCC_type_BGRX; f.frame_rate_N = FPS * 1000; f.frame_rate_D = 1000;
  f.picture_aspect_ratio = (float)W / H; f.frame_format_type = NDIlib_frame_format_type_progressive;
  f.timecode = NDIlib_send_timecode_synthesize; f.p_data = buf; f.line_stride_in_bytes = stride;
  for (long n = 0; !stop; n++) {
    int shift = (int)((n * 8) % W);
    for (int x = 0; x < W; x++) {
      const unsigned char* c = bars[(((x + shift) % W) * 8) / W];
      for (int y = 0; y < H; y++) { unsigned char* p = buf + y * stride + x * 4; p[0] = c[2]; p[1] = c[1]; p[2] = c[0]; p[3] = 255; }
    }
    int by = (int)((n * 6) % (H - 60));
    for (int y = by; y < by + 60; y++) for (int x = 40; x < 160; x++) memset(buf + y * stride + x * 4, 255, 4);
    N->send_send_video_v2(snd, &f);              // clock_video paces this to FPS
  }
  N->send_destroy(snd); N->destroy(); free(buf);
  return 0;
}
