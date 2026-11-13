// Windows only. The add-on calls Node-API functions that live in the program that loads it. They are imported from
// "node.exe" with delay loading, and this hook hands the delay loader the module of the running program instead, so
// the add-on also works when Node.js runs under another executable name.
#ifdef _WIN32
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary) return NULL;
  if (_stricmp(info->szDll, "node.exe") != 0) return NULL;
  return (FARPROC)GetModuleHandle(NULL);
}

const PfnDliHook __pfnDliNotifyHook2 = load_exe_hook;
#endif
