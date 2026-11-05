"""Typed MCP access to the user's running local Production Canvas instances."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ImageContent, TextContent, ToolAnnotations

SCHEMA = "production-canvas/mcp-session/v1"
HEX_ID = re.compile(r"[a-f0-9]{32}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
LOCAL_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)

mcp = FastMCP(
    "Production Canvas",
    instructions=(
        "Control the user's own local Production Canvas through its authenticated MCP bridge. "
        "List running instances first and use an exact instance_id. Read the active review state "
        "before mutations, then supply its project_id, revision and video SHA-256. "
        "Notes are local director records. Save only requested notes and reuse operation_id on retries. "
        "No tool grants owner approval, publishes media, executes arbitrary code or starts paid generation."
    ),
    log_level="WARNING",
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise RuntimeError("The local Canvas bridge may not redirect authenticated requests")


def registry_path() -> Path:
    configured = os.environ.get("PRODUCTION_CANVAS_MCP_REGISTRY")
    base = Path(configured) if configured else Path(os.environ.get("APPDATA", Path.home())) / "ProductionCanvas/mcp-sessions"
    if not base.is_absolute() or base.is_symlink():
        raise ValueError("The MCP registry must be an absolute, non-symlink directory")
    return base


def read_descriptor(path: Path, registry: Path) -> dict:
    if path.is_symlink() or not path.resolve().is_relative_to(registry.resolve()):
        raise ValueError("Session descriptor leaves the configured registry")
    if path.stat().st_size > 65536:
        raise ValueError("Session descriptor is too large")
    row = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(row, dict) or row.get("schema") != SCHEMA or not HEX_ID.fullmatch(str(row.get("instance_id", ""))):
        raise ValueError("Unsupported Canvas session descriptor")
    if not HASH.fullmatch(str(row.get("token", ""))):
        raise ValueError("Invalid session token")
    if type(row.get("pid")) is not int or row["pid"] <= 0:
        raise ValueError("Invalid Canvas process identity")
    parsed = urlsplit(str(row.get("origin", "")))
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or parsed.port is None or not 1 <= parsed.port <= 65535):
        raise ValueError("Canvas sessions must use literal HTTP loopback origins")
    return row


def descriptors() -> list[dict]:
    registry = registry_path()
    if not registry.is_dir():
        return []
    result = []
    for path in sorted(registry.glob("*.json"))[:64]:
        try:
            result.append(read_descriptor(path, registry))
        except (OSError, ValueError, TypeError):
            continue
    return result


def descriptor(instance_id: str) -> dict:
    if not HEX_ID.fullmatch(instance_id):
        raise ValueError("Use an instance_id returned by list_instances")
    rows = [row for row in descriptors() if row["instance_id"] == instance_id]
    if len(rows) != 1:
        raise ValueError("That Canvas instance is no longer registered. Read list_instances again.")
    return rows[0]


def request(row: dict, route: str, body: dict | None = None, timeout: float = 30) -> dict | list:
    if route not in ("/api/mcp/status", "/api/mcp/command"):
        raise ValueError("Unsupported Canvas MCP route")
    origin = row["origin"].rstrip("/")
    headers = {"X-Canvas-MCP": row["token"], "Accept": "application/json", "Origin": origin}
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if len(payload) > 1024 * 1024:
            raise ValueError("Canvas request exceeds 1 MiB")
        headers["Content-Type"] = "application/json"
    outgoing = Request(origin + route, data=payload, headers=headers, method="POST" if body is not None else "GET")
    try:
        with build_opener(NoRedirect).open(outgoing, timeout=timeout) as response:
            raw = response.read(20 * 1024 * 1024 + 1)
            if len(raw) > 20 * 1024 * 1024:
                raise ValueError("Canvas response exceeds the capture limit")
            result = json.loads(raw)
    except HTTPError as error:
        try:
            details = json.loads(error.read(65536))
        except (ValueError, OSError):
            details = {}
        raise RuntimeError(f"Canvas {error.code}: {details.get('error', 'request rejected')}") from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("Canvas did not answer. Check its window or select a live instance again.") from None
    if not isinstance(result, dict) and not isinstance(result, list):
        raise ValueError("Canvas returned an unexpected response")
    return result


def command(instance_id: str, name: str, **fields):
    return request(descriptor(instance_id), "/api/mcp/command", {"command": name, **fields})


def guard(project_id: str, expected_revision: str, expected_video_sha256: str) -> dict:
    if not project_id or len(project_id) > 128:
        raise ValueError("A current project_id is required")
    if not HASH.fullmatch(expected_revision) or not HASH.fullmatch(expected_video_sha256):
        raise ValueError("Use the revision and video SHA-256 returned by get_review_state")
    return dict(project_id=project_id, expected_revision=expected_revision,
                expected_video_sha256=expected_video_sha256)



@mcp.tool(annotations=READ_ONLY)
def list_instances() -> list[dict]:
    """List live local Canvas instances without returning session credentials."""
    result = []
    for row in descriptors():
        try:
            state = request(row, "/api/mcp/status", timeout=1.5)
        except (RuntimeError, ValueError):
            continue
        result.append({key: row.get(key) for key in
                       ("instance_id", "pid", "origin", "profile", "version", "build_commit", "started_at")}
                      | {"status": state})
    return result


@mcp.tool(annotations=READ_ONLY)
def get_status(instance_id: str) -> dict:
    """Read the selected desktop instance's current build and bridge capabilities."""
    return request(descriptor(instance_id), "/api/mcp/status")


@mcp.tool(annotations=READ_ONLY)
def list_projects(instance_id: str):
    """List project IDs already registered in the selected Canvas profile."""
    return command(instance_id, "list_projects")


@mcp.tool(annotations=LOCAL_WRITE)
def open_project(instance_id: str, project_id: str) -> dict:
    """Open a registered project in Canvas. Existing notes remain in their project stores."""
    return command(instance_id, "open_project", project_id=project_id)


@mcp.tool(annotations=LOCAL_WRITE)
def import_project(instance_id: str, manifest_path: str) -> dict:
    """Register and open an explicitly identified local project or workbench JSON file."""
    path = Path(manifest_path)
    if not path.is_absolute() or path.suffix.lower() != ".json" or not path.is_file():
        raise ValueError("An existing absolute local JSON manifest path is required")
    return command(instance_id, "import_project", manifest_path=str(path.resolve()))


@mcp.tool(annotations=READ_ONLY)
def get_review_state(instance_id: str) -> dict:
    """Read actual displayed frame, playback status, project, revision and video hash."""
    return command(instance_id, "state")


@mcp.tool(annotations=LOCAL_WRITE)
def set_review_view(instance_id: str, project_id: str, expected_revision: str,
                    expected_video_sha256: str, view: Literal["s03", "opening", "battle"]) -> dict:
    """Select the full film, opening or registered focus export in the current project."""
    if view not in ("s03", "opening", "battle"):
        raise ValueError("Use a registered full-film, opening or focus view")
    return command(instance_id, "select_view", view=view,
                   **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def seek_frame(instance_id: str, project_id: str, expected_revision: str,
               expected_video_sha256: str, frame: int) -> dict:
    """Seek to a zero-based full-film frame and wait for the displayed frame to settle."""
    if type(frame) is not int or frame < 0:
        raise ValueError("frame must be a nonnegative integer")
    return command(instance_id, "seek_frame", frame=frame,
                   **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def set_playback(instance_id: str, project_id: str, expected_revision: str,
                 expected_video_sha256: str, action: Literal["play", "pause"]) -> dict:
    """Play or pause the exact review version. Pause waits for its displayed frame."""
    if action not in ("play", "pause"):
        raise ValueError("action must be play or pause")
    return command(instance_id, action, **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def navigate_shot(instance_id: str, project_id: str, expected_revision: str,
                  expected_video_sha256: str, shot_id: str) -> dict:
    """Jump to a real shot ID from the current supported timeline."""
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", shot_id):
        raise ValueError("Use a shot_id from the current timeline")
    return command(instance_id, "navigate_shot", shot_id=shot_id,
                   **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def open_direction(instance_id: str, project_id: str, expected_revision: str,
                   expected_video_sha256: str) -> dict:
    """Pause and open the same frame-linked quick-note form used by the director."""
    return command(instance_id, "open_direction", **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def save_direction(instance_id: str, project_id: str, expected_revision: str,
                   expected_video_sha256: str, text: str, operation_id: str) -> dict:
    """Save requested director text at the current displayed frame through the normal note flow.

    Supply a fresh 32-character lowercase hex operation_id for a new note and
    reuse it only for retries of that exact note. This does not approve video.
    """
    if not text.strip() or len(text) > 16000:
        raise ValueError("Direction text must contain 1–16000 characters")
    if not HEX_ID.fullmatch(operation_id):
        raise ValueError("operation_id must contain 32 lowercase hexadecimal characters")
    return command(instance_id, "save_direction", text=text, operation_id=operation_id,
                   **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=LOCAL_WRITE)
def jump_to_direction(instance_id: str, project_id: str, expected_revision: str,
                      expected_video_sha256: str, direction_id: str) -> dict:
    """Resolve an existing direction's version-aware anchor and return to its displayed frame."""
    if not HEX_ID.fullmatch(direction_id):
        raise ValueError("Use a direction_id returned by Canvas")
    return command(instance_id, "jump_to_direction", direction_id=direction_id,
                   **guard(project_id, expected_revision, expected_video_sha256))


@mcp.tool(annotations=READ_ONLY, structured_output=False)
def capture_frame(instance_id: str, project_id: str, expected_revision: str,
                  expected_video_sha256: str) -> list[TextContent | ImageContent]:
    """Capture the actual app window and return its accompanying displayed-frame identity."""
    result = command(instance_id, "capture_frame", **guard(project_id, expected_revision, expected_video_sha256))
    raw = base64.b64decode(result["png_base64"], validate=True)
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Canvas did not return a PNG capture")
    return [TextContent(type="text", text=json.dumps(result.get("state", {}), ensure_ascii=False)),
            Image(data=raw, format="png").to_image_content()]


if __name__ == "__main__":
    mcp.run(transport="stdio")
