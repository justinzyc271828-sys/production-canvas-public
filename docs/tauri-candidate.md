# Production Canvas on Windows

The Windows x64 package uses a Rust/Tauri desktop host and the system WebView2
Runtime. The portable plugin directory carries its own Node.js review service
runtime and isolated Python MCP adapter. The existing manifest, timeline and
frame annotation formats are shared with the Electron edition.

## Open the package

Extract the complete package. Open `desktop/production-canvas.exe` for
the Chinese interface or run scripts/start-canvas.ps1 for the English plugin
entry. The launcher also accepts -Language zh-CN and -ProfileDirectory.
The executable is unsigned. The Rust/Tauri desktop uses its own profile. A
second launch with a matching profile forwards an exact local manifest or MP4
path to the existing window.

The Project menu opens local film folders, manifests, workbench tool settings,
and bound review videos. The storyboard link opens a protected text window.
ComfyUI inspection uses a separate WebView and allows only local reads.
Kdenlive draft rendering and the vetted local reference workflow use the
existing Python worker and the project tool configuration. On deep Windows
paths, the worker renders into a short temporary directory and places the
verified MP4 back in the project. This uses the workspace roots reported by
the configured Kdenlive MCP server.

## Build

Use the pinned npm dependencies and the Windows MSVC Rust toolchain.
Run npm ci, then use scripts/pack-tauri.ps1 with -Destination, -NodeDirectory
(the official Windows x64 distribution including LICENSE), and -PythonDirectory
(the isolated, dependency-complete MCP runtime). The package receipt records
the exact source commit and the three executable SHA-256 values.
Run npm run check, npm run verify:sample, npm run verify:opening and the packaged
Tauri verification before adoption. The bundled Python entry point remains
scripts/start-mcp.ps1.

## Adopt or roll back

scripts/switch-local-canvas.ps1 defaults to Plan. Pass the actual Canvas shortcut
and the Canvas-specific Open with registry command. Its plan lists the selected
files, project count, destination profile, and candidate SHA-256. Apply requires
the reviewed SHA-256 and new profile and backup paths. It copies project and tool
settings and the profile-owned samples, then changes the two Canvas entry
points. The user's default MP4 app is a separate Windows setting.

Use -Action Rollback with the recorded -BackupDirectory to restore the previous
shortcut bytes and command. New review records stay in the project and the
candidate profile. Stop if the entry points were edited since the switch.
