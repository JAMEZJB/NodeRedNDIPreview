<#
  Build the add-on for Windows x64.

  Needs: the Visual Studio 2022 C++ build tools with the Windows 11 SDK component, Node.js's Node-API header files, and the NDI SDK's header files
  (install the NDI SDK for Windows from ndi.video). Only the SDK's HEADERS are used: nothing from the SDK is linked
  into or copied next to the output. No npm packages and no node-gyp are needed.

  Output: prebuilds\win32-x64\ndi_preview.node

  -NdiInclude   folder with Processing.NDI.Lib.h   (default: $env:NDI_SDK_DIR\Include)
  -NodeInclude  folder with node_api.h             (default: $env:NODE_API_INCLUDE)
#>
param(
  [string]$NdiInclude = $(if ($env:NDI_SDK_DIR) { Join-Path $env:NDI_SDK_DIR "Include" } else { "" }),
  [string]$NodeInclude = $env:NODE_API_INCLUDE
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $NdiInclude -or -not (Test-Path (Join-Path $NdiInclude "Processing.NDI.Lib.h"))) {
  throw "NDI SDK headers not found (give -NdiInclude, or set NDI_SDK_DIR to the NDI SDK folder)"
}
if (-not $NodeInclude -or -not (Test-Path (Join-Path $NodeInclude "node_api.h"))) {
  throw "Node-API headers not found (give -NodeInclude, or set NODE_API_INCLUDE)"
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Visual Studio C++ build tools not found" }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"

$out = Join-Path $here "prebuilds\win32-x64"
$obj = Join-Path $here "native\build\win32-x64"
New-Item -ItemType Directory -Force -Path $out, $obj | Out-Null

# An import library for the Node-API functions the add-on uses, taken from the running program at load time
# (see native\win_delay_load_hook.c).
$src = Get-Content (Join-Path $here "native\ndi_preview.c") -Raw
$names = [regex]::Matches($src, "\b(napi_[a-z0-9_]+)\s*\(") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$def = @("NAME node.exe", "EXPORTS") + $names
Set-Content -Path (Join-Path $obj "node_api.def") -Value $def -Encoding ascii

$cmd = @(
  "`"$vcvars`" >nul",
  "(if not defined WindowsSdkDir (echo The Windows SDK is not installed: add the Windows 11 SDK component to the Visual Studio C++ build tools. & exit /b 3))",
  "cd /d `"$obj`"",
  "lib /nologo /def:node_api.def /machine:x64 /out:node_api.lib",
  # /wd4996: the NDI SDK's own Processing.NDI.DynamicLoad.h lists its deprecated older types; this code uses none of them
  ("cl /nologo /O2 /W3 /wd4996 /std:c11 /LD /DNAPI_VERSION=8 /DNODE_GYP_MODULE_NAME=ndi_preview " +
   "/I`"$NodeInclude`" /I`"$NdiInclude`" `"$here\native\ndi_preview.c`" `"$here\native\win_delay_load_hook.c`" " +
   "/Fe`"$out\ndi_preview.node`" /link node_api.lib delayimp.lib /DELAYLOAD:node.exe")
) -join " && "
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $out "ndi_preview.lib"), (Join-Path $out "ndi_preview.exp")

# The add-on must not import an NDI DLL: the runtime is loaded by path at run time.
$imports = cmd /c "`"$vcvars`" >nul && dumpbin /nologo /dependents `"$out\ndi_preview.node`""
if ($imports -match "(?i)ndi\.lib|processing\.ndi") { throw "the add-on imports an NDI DLL" }
Write-Host "ok: $out\ndi_preview.node"
$imports | Where-Object { $_ -match "\.(dll|exe)\s*$" } | ForEach-Object { Write-Host "  imports $($_.Trim())" }
