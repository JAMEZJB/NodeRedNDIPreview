// ndi_preview.node: the small NDI receive binding the Node-RED NDI Preview nodes need. Plain C and Node-API.
//
// It contains no NDI code. The NDI Runtime the user installed is loaded at run time, the way the NDI SDK
// documents for dynamic loading:
//   1. an explicit path, if the caller gives one;
//   2. the folder in the NDI_RUNTIME_DIR_V6 environment variable (set by the NDI 6 Runtime installer on Windows);
//   3. macOS only: /usr/local/lib/libndi.dylib, where the NDI Runtime and NDI Tools installers put it.
// Only absolute paths are ever loaded, so no library is picked up from the current folder or a search path.
// If none loads, load() says so and gives the NDI download link.
//
// Every call here is non-blocking: FrameSync capture returns at once and discovery is polled.
//
// JS API (all synchronous, all cheap):
//   load([path])        -> { ok:true, version, path, loader } | { ok:false, error, url }   (idempotent once ok)
//   findOpen() / findSources(h) / findClose(h)   -> [{ name, address }]
//   open({ name, address, bandwidth:'lowest'|'highest', label })   -> handle
//   grab(h, [since])    -> null (no frame yet) | false (no frame newer than `since`) |
//                          { xres, yres, frameRateN, frameRateD, fourCC, lineStrideBytes,
//                            timestamp (100 ns units since 1970, as a Number), data: Buffer }
//   stats(h)            -> { connections, framesTotal, framesDropped }
//   close(h)
#include <node_api.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
#include "Processing.NDI.Lib.h"

static const NDIlib_v6* NDI = NULL;
static char g_path[1024] = "";
static char g_error[1400] = "";
static const char* g_loader = "";

#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, NULL, "N-API call failed: " #call); return NULL; } } while (0)

// ---- loading the runtime ---------------------------------------------------------------------------------------

#ifdef _WIN32
static void* lib_open(const char* utf8path) {
  wchar_t w[1024];
  if (!MultiByteToWideChar(CP_UTF8, 0, utf8path, -1, w, (int)(sizeof w / sizeof w[0]))) return NULL;
  // LOAD_WITH_ALTERED_SEARCH_PATH: the runtime's own DLLs are found next to it, not in the current folder.
  return (void*)LoadLibraryExW(w, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
}
static void* lib_sym(void* lib, const char* name) { return (void*)GetProcAddress((HMODULE)lib, name); }
static void lib_close(void* lib) { FreeLibrary((HMODULE)lib); }
static bool is_absolute(const char* p) {
  return (p[0] && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) || (p[0] == '\\' && p[1] == '\\');
}
// the environment variable as UTF-8 (getenv would mangle non-ASCII folder names)
static bool env_utf8(const char* name, char* out, size_t cap) {
  wchar_t wname[64], wval[1024];
  if (!MultiByteToWideChar(CP_UTF8, 0, name, -1, wname, 64)) return false;
  DWORD n = GetEnvironmentVariableW(wname, wval, (DWORD)(sizeof wval / sizeof wval[0]));
  if (n == 0 || n >= sizeof wval / sizeof wval[0]) return false;
  return WideCharToMultiByte(CP_UTF8, 0, wval, -1, out, (int)cap, NULL, NULL) > 0;
}
#define PATH_SEP "\\"
#else
static void* lib_open(const char* path) { return dlopen(path, RTLD_LOCAL | RTLD_LAZY); }
static void* lib_sym(void* lib, const char* name) { return dlsym(lib, name); }
static void lib_close(void* lib) { dlclose(lib); }
static bool is_absolute(const char* p) { return p[0] == '/'; }
static bool env_utf8(const char* name, char* out, size_t cap) {
  const char* v = getenv(name);
  if (!v || !*v) return false;
  snprintf(out, cap, "%s", v);
  return true;
}
#define PATH_SEP "/"
#endif

// Try one candidate. Everything this add-on calls is in the v3.6 part of the runtime's function table, which only
// ever grows at the end, so the newest loader the runtime exports will do: NDIlib_v6_load (runtime 6.2 and later),
// else NDIlib_v5_load (5.x, 6.0 and 6.1). A runtime with neither (4.x or older) is refused and unloaded again.
static bool try_runtime(const char* path) {
  if (!is_absolute(path)) { snprintf(g_error, sizeof g_error, "not an absolute path: %s", path); return false; }
  void* lib = lib_open(path);
  if (!lib) {
#ifdef _WIN32
    snprintf(g_error, sizeof g_error, "could not load %s (Windows error %lu)", path, (unsigned long)GetLastError());
#else
    const char* why = dlerror();
    snprintf(g_error, sizeof g_error, "could not load %s%s%s", path, why ? ": " : "", why ? why : "");
#endif
    return false;
  }
  const char* loader = "v6";
  const NDIlib_v6* (*load)(void) = NULL;
  *(void**)&load = lib_sym(lib, "NDIlib_v6_load");
  if (!load) { loader = "v5"; *(void**)&load = lib_sym(lib, "NDIlib_v5_load"); }
  if (!load) {
    snprintf(g_error, sizeof g_error, "the NDI runtime at %s is older than NDI 5", path);
    lib_close(lib);
    return false;
  }
  const NDIlib_v6* api = load();
  if (!api || !api->initialize()) {
    snprintf(g_error, sizeof g_error, "the NDI runtime at %s did not start (this computer's processor may not be supported)", path);
    lib_close(lib);
    return false;
  }
  NDI = api;              // the library stays loaded for the life of the process
  g_loader = loader;
  snprintf(g_path, sizeof g_path, "%s", path);
  return true;
}

static napi_value js_load(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (!NDI) {
    g_error[0] = 0;
    napi_valuetype t = napi_undefined;
    if (argc > 0) napi_typeof(env, argv[0], &t);
    if (t == napi_string) {                                   // an explicit path: only that one
      char want[1024]; size_t n;
      napi_get_value_string_utf8(env, argv[0], want, sizeof want, &n);
      if (!try_runtime(want) && !g_error[0]) snprintf(g_error, sizeof g_error, "no NDI runtime could be loaded from %s", want);
    } else {
      char dir[1024], cand[1200];
      if (env_utf8(NDILIB_REDIST_FOLDER, dir, sizeof dir)) {
        size_t L = strlen(dir);
        bool sep = L > 0 && (dir[L - 1] == '/' || dir[L - 1] == '\\');
        snprintf(cand, sizeof cand, "%s%s%s", dir, sep ? "" : PATH_SEP, NDILIB_LIBRARY_NAME);
        try_runtime(cand);
      }
#ifdef __APPLE__
      if (!NDI) try_runtime("/usr/local/lib/" NDILIB_LIBRARY_NAME);
#endif
      if (!NDI && !g_error[0]) snprintf(g_error, sizeof g_error, "the NDI Runtime is not installed");
    }
  }
  napi_value o, v; CHECK(napi_create_object(env, &o));
  CHECK(napi_get_boolean(env, NDI != NULL, &v)); napi_set_named_property(env, o, "ok", v);
  if (NDI) {
    const char* ver = NDI->version();
    napi_create_string_utf8(env, ver ? ver : "", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "version", v);
    napi_create_string_utf8(env, g_path, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "path", v);
    napi_create_string_utf8(env, g_loader, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "loader", v);
  } else {
    napi_create_string_utf8(env, g_error, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "error", v);
    napi_create_string_utf8(env, NDILIB_REDIST_URL, NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "url", v);
  }
  return o;
}

#define NEED_NDI() do { if (!NDI) { napi_throw_error(env, "ENDIRUNTIME", "the NDI Runtime is not loaded"); return NULL; } } while (0)

// ---- handles: a JS external wrapping a small struct; the finalizer cleans up if JS forgets close() --------------

typedef struct { NDIlib_recv_instance_t recv; NDIlib_framesync_instance_t sync; } Rx;
typedef struct { NDIlib_find_instance_t find; } Fx;

static void rx_free(Rx* r) {
  if (r->sync) { NDI->framesync_destroy(r->sync); r->sync = NULL; }   // FrameSync before its receiver
  if (r->recv) { NDI->recv_destroy(r->recv); r->recv = NULL; }
}
static void rx_finalize(napi_env env, void* data, void* hint) { (void)env; (void)hint; if (NDI) rx_free((Rx*)data); free(data); }
static void fx_finalize(napi_env env, void* data, void* hint) {
  (void)env; (void)hint; Fx* f = (Fx*)data; if (NDI && f->find) NDI->find_destroy(f->find); free(f);
}

static void* get_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "expected a handle"); return NULL;
  }
  void* p = NULL;
  if (napi_get_value_external(env, argv[0], &p) != napi_ok || !p) { napi_throw_type_error(env, NULL, "expected a handle"); return NULL; }
  return p;
}

static bool get_str(napi_env env, napi_value obj, const char* key, char* out, size_t cap) {
  bool has = false; napi_value v; napi_valuetype t; size_t n = 0;
  out[0] = 0;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return false;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok || napi_typeof(env, v, &t) != napi_ok) return false;
  if (t != napi_string) return false;
  if (napi_get_value_string_utf8(env, v, out, cap, &n) != napi_ok) { out[0] = 0; return false; }
  return n > 0;
}

// ---- receiving --------------------------------------------------------------------------------------------------

static napi_value js_open(napi_env env, napi_callback_info info) {
  NEED_NDI();
  size_t argc = 1; napi_value argv[1]; CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  napi_valuetype t = napi_undefined;
  if (argc > 0) napi_typeof(env, argv[0], &t);
  if (t != napi_object) { napi_throw_type_error(env, NULL, "open({ name, address, bandwidth, label })"); return NULL; }
  char name[512], addr[256], bw[16], label[256];
  bool hn = get_str(env, argv[0], "name", name, sizeof name), ha = get_str(env, argv[0], "address", addr, sizeof addr);
  get_str(env, argv[0], "bandwidth", bw, sizeof bw);
  if (!get_str(env, argv[0], "label", label, sizeof label)) snprintf(label, sizeof label, "Node-RED NDI Preview");
  if (!hn && !ha) { napi_throw_type_error(env, NULL, "open() needs a source name or an address"); return NULL; }

  NDIlib_recv_create_v3_t cfg;
  memset(&cfg, 0, sizeof cfg);
  cfg.source_to_connect_to.p_ndi_name = hn ? name : NULL;
  cfg.source_to_connect_to.p_url_address = ha ? addr : NULL;
  cfg.color_format = NDIlib_recv_color_format_RGBX_RGBA;    // every frame arrives as RGBX or RGBA
  cfg.bandwidth = strcmp(bw, "highest") == 0 ? NDIlib_recv_bandwidth_highest : NDIlib_recv_bandwidth_lowest;
  cfg.allow_video_fields = false;
  cfg.p_ndi_recv_name = label;
  // the runtime copies the strings it needs during create, so stack buffers are fine here
  Rx* r = (Rx*)calloc(1, sizeof(Rx));
  if (!r) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  r->recv = NDI->recv_create_v3(&cfg);
  if (r->recv) r->sync = NDI->framesync_create(r->recv);
  if (!r->recv || !r->sync) { rx_free(r); free(r); napi_throw_error(env, NULL, "could not create an NDI receiver"); return NULL; }
  // Tally is never set: a preview must never light a camera's on-air lamp.
  napi_value h;
  if (napi_create_external(env, r, rx_finalize, NULL, &h) != napi_ok) { rx_free(r); free(r); napi_throw_error(env, NULL, "N-API call failed"); return NULL; }
  return h;
}

// grab(h, [since]): the newest frame. When `since` is the timestamp of the frame the caller already has and no newer
// frame has arrived, returns false without copying anything (FrameSync repeats the last frame until a new one comes).
static napi_value js_grab(napi_env env, napi_callback_info info) {
  NEED_NDI();
  size_t argc = 2; napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) { napi_throw_type_error(env, NULL, "expected a handle"); return NULL; }
  Rx* r = NULL;
  if (napi_get_value_external(env, argv[0], (void**)&r) != napi_ok || !r) { napi_throw_type_error(env, NULL, "expected a handle"); return NULL; }
  bool have_since = false; double since = 0;
  if (argc > 1) { napi_valuetype t; napi_typeof(env, argv[1], &t); if (t == napi_number) { napi_get_value_double(env, argv[1], &since); have_since = true; } }
  napi_value out; napi_get_null(env, &out);
  if (!r->sync) return out;
  NDIlib_video_frame_v2_t f; memset(&f, 0, sizeof f);
  NDI->framesync_capture_video(r->sync, &f, NDIlib_frame_format_type_progressive);   // returns at once
  if (!f.p_data || f.xres <= 0 || f.yres <= 0 || f.line_stride_in_bytes <= 0) {         // no frame yet
    NDI->framesync_free_video(r->sync, &f);
    return out;
  }
  if (have_since && (double)f.timestamp == since) {                                     // nothing new
    NDI->framesync_free_video(r->sync, &f);
    napi_get_boolean(env, false, &out);
    return out;
  }
  size_t bytes = (size_t)f.line_stride_in_bytes * (size_t)f.yres;
  napi_value o, v, buf; void* dst = NULL;
  // one copy, straight into a Node.js buffer (works where external buffers are not allowed, e.g. under Electron)
  if (napi_create_buffer(env, bytes, &dst, &buf) != napi_ok || !dst) {
    NDI->framesync_free_video(r->sync, &f);
    napi_throw_error(env, NULL, "out of memory"); return NULL;
  }
  memcpy(dst, f.p_data, bytes);
  if (napi_create_object(env, &o) != napi_ok) { NDI->framesync_free_video(r->sync, &f); napi_throw_error(env, NULL, "N-API call failed"); return NULL; }
#define SETI(k, x) do { napi_create_int32(env, (int32_t)(x), &v); napi_set_named_property(env, o, k, v); } while (0)
  SETI("xres", f.xres); SETI("yres", f.yres); SETI("frameRateN", f.frame_rate_N); SETI("frameRateD", f.frame_rate_D);
  SETI("lineStrideBytes", f.line_stride_in_bytes);
#undef SETI
  napi_create_uint32(env, (uint32_t)f.FourCC, &v); napi_set_named_property(env, o, "fourCC", v);
  napi_create_double(env, (double)f.timestamp, &v); napi_set_named_property(env, o, "timestamp", v);
  NDI->framesync_free_video(r->sync, &f);
  napi_set_named_property(env, o, "data", buf);
  return o;
}

static napi_value js_stats(napi_env env, napi_callback_info info) {
  NEED_NDI();
  Rx* r = (Rx*)get_handle(env, info); if (!r) return NULL;
  napi_value o, v; CHECK(napi_create_object(env, &o));
  if (!r->recv) return o;
  NDIlib_recv_performance_t total, dropped; memset(&total, 0, sizeof total); memset(&dropped, 0, sizeof dropped);
  NDI->recv_get_performance(r->recv, &total, &dropped);
  napi_create_int32(env, NDI->recv_get_no_connections(r->recv), &v); napi_set_named_property(env, o, "connections", v);
  napi_create_double(env, (double)total.video_frames, &v); napi_set_named_property(env, o, "framesTotal", v);
  napi_create_double(env, (double)dropped.video_frames, &v); napi_set_named_property(env, o, "framesDropped", v);
  return o;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  NEED_NDI();
  Rx* r = (Rx*)get_handle(env, info); if (!r) return NULL;
  rx_free(r);                       // the struct itself is freed by the finalizer
  return NULL;
}

// ---- discovery --------------------------------------------------------------------------------------------------

static napi_value js_find_open(napi_env env, napi_callback_info info) {
  (void)info; NEED_NDI();
  NDIlib_find_create_t cfg; memset(&cfg, 0, sizeof cfg);
  cfg.show_local_sources = true;
  Fx* f = (Fx*)calloc(1, sizeof(Fx));
  if (!f) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  f->find = NDI->find_create_v2(&cfg);
  if (!f->find) { free(f); napi_throw_error(env, NULL, "could not start NDI discovery"); return NULL; }
  napi_value h;
  if (napi_create_external(env, f, fx_finalize, NULL, &h) != napi_ok) { NDI->find_destroy(f->find); free(f); napi_throw_error(env, NULL, "N-API call failed"); return NULL; }
  return h;
}

static napi_value js_find_sources(napi_env env, napi_callback_info info) {
  NEED_NDI();
  Fx* f = (Fx*)get_handle(env, info); if (!f) return NULL;
  napi_value arr; CHECK(napi_create_array(env, &arr));
  if (!f->find) return arr;
  uint32_t n = 0;
  const NDIlib_source_t* s = NDI->find_get_current_sources(f->find, &n);   // a snapshot; does not wait
  for (uint32_t i = 0; s && i < n; i++) {
    napi_value o, v; napi_create_object(env, &o);
    napi_create_string_utf8(env, s[i].p_ndi_name ? s[i].p_ndi_name : "", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "name", v);
    napi_create_string_utf8(env, s[i].p_url_address ? s[i].p_url_address : "", NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "address", v);
    napi_set_element(env, arr, i, o);
  }
  return arr;
}

static napi_value js_find_close(napi_env env, napi_callback_info info) {
  NEED_NDI();
  Fx* f = (Fx*)get_handle(env, info); if (!f) return NULL;
  if (f->find) { NDI->find_destroy(f->find); f->find = NULL; }
  return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor d[] = {
    { "load", 0, js_load, 0, 0, 0, napi_default, 0 },
    { "open", 0, js_open, 0, 0, 0, napi_default, 0 },
    { "grab", 0, js_grab, 0, 0, 0, napi_default, 0 },
    { "stats", 0, js_stats, 0, 0, 0, napi_default, 0 },
    { "close", 0, js_close, 0, 0, 0, napi_default, 0 },
    { "findOpen", 0, js_find_open, 0, 0, 0, napi_default, 0 },
    { "findSources", 0, js_find_sources, 0, 0, 0, napi_default, 0 },
    { "findClose", 0, js_find_close, 0, 0, 0, napi_default, 0 },
  };
  napi_define_properties(env, exports, sizeof d / sizeof d[0], d);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
