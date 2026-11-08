"""Exercise the staged plugin launchers and the shipped stdio server."""

import asyncio
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def decode(result):
    if result.isError:
        raise RuntimeError(" ".join(item.text for item in result.content if item.type == "text"))
    if result.structuredContent is not None:
        return result.structuredContent.get("result", result.structuredContent)
    return json.loads(next(item.text for item in result.content if item.type == "text"))


async def verify(package, profile, powershell, environment):
    launcher = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
    subprocess.run(
        launcher + [str(package / "scripts/start-canvas.ps1"), "-ProfileDirectory", str(profile)],
        env=environment, check=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    parameters = StdioServerParameters(
        command=powershell,
        args=launcher[1:] + [str(package / "scripts/start-mcp.ps1")],
        cwd=package, env=environment,
    )
    async with stdio_client(parameters) as (incoming, outgoing):
        async with ClientSession(incoming, outgoing) as client:
            await client.initialize()
            tools = await client.list_tools()
            names = sorted(tool.name for tool in tools.tools)
            assert len(names) == 15
            session = None
            for _ in range(35):
                rows = decode(await client.call_tool("list_instances", {}))
                session = next((row for row in rows if Path(row["profile"]) == profile
                                and row["status"]["state"]["ready"]), None)
                if session:
                    break
                await asyncio.sleep(.3)
            assert session, "The package launcher did not create a ready instance"
            state = session["status"]["state"]
            assert session["version"] == "1.6.0-rc.1"
            assert state["frames"] == 720 and state["fps"] == 24
            guard = {
                "instance_id": session["instance_id"], "project_id": state["project_id"],
                "expected_revision": state["revision"], "expected_video_sha256": state["video_sha256"],
            }
            sought = decode(await client.call_tool("seek_frame", {**guard, "frame": 302}))
            assert sought["displayed_frame"] == 302
            shot = await client.call_tool("capture_frame", guard)
            assert not shot.isError
            captured = json.loads(next(item.text for item in shot.content if item.type == "text"))
            image = next(item for item in shot.content if item.type == "image")
            assert captured["displayed_frame"] == 302 and image.mimeType == "image/png"
            assert base64.b64decode(image.data).startswith(b"\x89PNG\r\n\x1a\n")
            return {
                "tools": names, "build": session["build_commit"], "frame": 302,
                "captureMime": image.mimeType, "bundledRuntimes": True,
            }


def main():
    package = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve()
    profile = Path(tempfile.mkdtemp(prefix="canvas-tauri-plugin-")).resolve()
    registry = profile / "sessions"
    windows = Path(os.environ["SystemRoot"])
    powershell = str(windows / "System32/WindowsPowerShell/v1.0/powershell.exe")
    environment = dict(os.environ, PRODUCTION_CANVAS_MCP_REGISTRY=str(registry),
                       CANVAS_NODE=str(profile / "missing-node.exe"),
                       PATH=os.pathsep.join((str(windows / "System32"), str(windows))))
    try:
        report = asyncio.run(verify(package, profile, powershell, environment))
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
    finally:
        for descriptor in registry.glob("*.json"):
            if not re.fullmatch(r"[0-9a-f]{32}\.json", descriptor.name):
                continue
            row = json.loads(descriptor.read_text(encoding="utf-8"))
            if Path(row["profile"]) == profile and type(row["pid"]) is int:
                command = (
                    f"$p = Get-Process -Id {row['pid']} -ErrorAction SilentlyContinue; "
                    "if ($p -and $p.ProcessName -eq 'production-canvas') { $null = $p.CloseMainWindow() }"
                )
                subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-Command", command],
                               check=False, creationflags=subprocess.CREATE_NO_WINDOW)


if __name__ == "__main__":
    main()
