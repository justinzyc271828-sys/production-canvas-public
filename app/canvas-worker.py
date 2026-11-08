"""Run bounded project-canvas jobs through the existing local MCP servers."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

WINDOWS_MAX_PATH = 260


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


async def call(session, name, args=None):
    result = await session.call_tool(name, args or {})
    response = result.model_dump(by_alias=True)
    if response.get("isError"):
        raise RuntimeError(" ".join(part.text for part in result.content if part.type == "text"))
    value = response.get("structuredContent")
    if not value:
        value = json.loads(next(part.text for part in result.content if part.type == "text"))
    if isinstance(value.get("result"), dict) and len(value) == 1:
        value = value["result"]
    if value.get("ok") is False:
        raise RuntimeError(str(value.get("error") or value))
    return value


def needs_short_render_path(directory):
    render_file = directory / "kdenlive-mcp-jobs" / ("0" * 32) / "render-incomplete.mp4"
    return os.name == "nt" and len(str(render_file).encode("utf-16-le")) // 2 >= WINDOWS_MAX_PATH


def publish_staged_preview(run, movie, receipt, revision):
    if receipt.get("source_revision") != revision or Path(receipt["output"]).resolve() != movie:
        raise RuntimeError("The rendered preview does not match the draft")
    preview = run / "preview.mp4"
    target = tempfile.NamedTemporaryFile(dir=run, prefix="preview-", suffix=".pending", delete=False)
    pending = Path(target.name)
    try:
        with target, movie.open("rb") as source:
            shutil.copyfileobj(source, target, 1024 * 1024)
        sha256 = digest(pending)
        if sha256 != receipt.get("sha256"):
            raise RuntimeError("The rendered preview does not match its receipt")
        with (run / "render-receipt.json").open("x", encoding="utf-8") as handle:
            json.dump({**receipt, "output": str(preview)}, handle)
        os.link(pending, preview)
        return sha256
    finally:
        pending.unlink()


async def render_preview(session, run, stage, options, publish):
    staged = stage != run
    movie = stage / "preview.mp4"
    publish("running", "starting-render")
    started = await call(session, "start_render", {
        **options, "output_path": str(movie), "quality": "preview"
    })
    job_path = started["job_path"]
    location = {"staging_directory": str(stage)} if staged else {"job_path": job_path}
    publish("running", "render", **location)
    unconfirmed = "Render still unconfirmed. Inspect the stored job before retrying."
    for attempt in range(7200 if staged else 180):
        state = await call(session, "get_render_status", {"job_path": job_path})
        phase = state.get("state") or state.get("status")
        if phase == "completed":
            revision = digest(run / "draft.kdenlive-cli.json")
            if (not movie.is_file() or state.get("full_decode") != "passed" or
                    revision != options["expected_revision"]):
                raise RuntimeError("Kdenlive did not verify the preview")
            sha256 = publish_staged_preview(run, movie, state, revision) if staged else digest(movie)
            publish("completed", "review", revision=revision, preview_sha256=sha256, error=None)
            return True
        if phase in ("failed", "error", "cancelled"):
            raise RuntimeError(str(state.get("error") or state))
        if staged and attempt == 179:
            publish("attention", "render", error=unconfirmed)
        await asyncio.sleep(2)
    publish("attention", "render", error=unconfirmed)
    return False


async def render_at_short_path(session, connection, run, options, publish):
    roots = (await call(session, "get_status")).get("workspace_roots")
    if not isinstance(roots, list) or not roots or not all(
        isinstance(root, str) and Path(root).is_absolute() for root in roots
    ):
        raise RuntimeError("The Kdenlive adapter must report its workspace roots to render from a deep path")
    parent = Path(tempfile.gettempdir()).resolve()
    stage = Path(tempfile.mkdtemp(prefix="canvas-render-", dir=parent)).resolve()
    if stage.parent != parent:
        raise RuntimeError("Unexpected Kdenlive staging directory")
    if needs_short_render_path(stage):
        stage.rmdir()
        raise RuntimeError("Choose a shorter Windows temporary directory for Kdenlive rendering")
    env = {**(connection.get("env") or {}), "KDENLIVE_MCP_ROOTS": os.pathsep.join([*roots, str(stage)])}
    parameters = StdioServerParameters(**{**connection, "env": env})
    async with stdio_client(parameters) as (incoming, outgoing):
        async with ClientSession(incoming, outgoing) as renderer:
            await renderer.initialize()
            completed = await render_preview(renderer, run, stage, options, publish)
    if completed and stage.resolve() == stage:
        shutil.rmtree(stage, ignore_errors=True)


async def edit_preview(session, connection, run, request, publish):
    source = Path(request["source"])
    project = run / "draft.kdenlive-cli.json"
    params = {"project_path": str(source), "expected_revision": request["revision"]}
    publish("running", "copy")
    copied = await call(session, "copy_project", {**params, "new_project_path": str(project)})
    revision = copied.get("revision") or digest(project)
    options = {"project_path": str(project), "expected_revision": revision}
    publish("running", "edit")
    for tool, args in request["edits"]:
        if tool not in ("trim_clip", "move_clip"):
            raise ValueError("Unsupported editing operation")
        edited = await call(session, tool, {**options, **args})
        options["expected_revision"] = edited.get("revision") or digest(project)
    await call(session, "export_project", {**options, "output_path": str(run / "draft.kdenlive")})
    if needs_short_render_path(run):
        await render_at_short_path(session, connection, run, options, publish)
    else:
        await render_preview(session, run, run, options, publish)


async def render_refs(session, run, request, publish):
    raw = Path(request["source"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != request["revision"]:
        raise ValueError("The verified workflow changed")
    original = json.loads(raw)
    scene = Path(request["scene"])
    for node in original.values():
        if node.get("class_type") != "BlenderReferenceRender":
            raise ValueError("Only the vetted Blender reference graph can run here")
        if Path(node["inputs"]["blend_file"]).resolve() != scene.resolve():
            raise ValueError("Unexpected reference scene")
    if set(original) != {"1", "2", "3"}:
        raise ValueError("Expected exactly three local render nodes")
    frozen = run / "reference-workflow.json"
    with frozen.open("xb") as handle:
        handle.write(raw)
    publish("running", "validate")
    verdict = await call(session, "validate_workflow", {"workflow_path": str(frozen)})
    if not verdict.get("valid") or verdict.get("spends_credits") is not False or verdict.get("partner_nodes"):
        raise RuntimeError("The live validation did not prove a local, zero-credit workflow")
    publish("running", "comfy")
    job = await call(session, "run_workflow", {
        "workflow_path": str(frozen), "wait": True, "confirm_spend": False
    })
    if job.get("status") != "completed" or len(job.get("outputs_by_node", {})) != 3:
        raise RuntimeError("ComfyUI did not return all three images")
    from urllib.parse import urlsplit
    images = []
    for node_id in ("1", "2", "3"):
        url = job["outputs_by_node"][node_id][0]
        parts = urlsplit(url)
        if (parts.scheme, parts.netloc, parts.path) != ("http", "127.0.0.1:8188", "/view"):
            raise ValueError("Unexpected ComfyUI output address")
        from urllib.request import urlopen
        name = "reference-" + "abc"[int(node_id) - 1] + ".png"
        with urlopen(url, timeout=10) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Expected a bounded PNG result")
        with (run / name).open("xb") as handle:
            handle.write(data)
        images.append(name)
    publish("completed", "review", prompt_id=job["prompt_id"], images=images)


async def main():
    run = Path(sys.argv[1]).resolve(strict=True)
    request = read(run / "request.json")
    config = read(Path(sys.argv[2]))
    kind = request["kind"]
    connection = config["kdenlive" if kind == "edit" else "comfy"]
    state = {}

    def publish(status, stage, **details):
        state.update(status=status, stage=stage, updated_at=stamp(), **details)
        temporary = run / "status.pending"
        temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        temporary.replace(run / "status.json")

    try:
        publish("running", "connect")
        if digest(Path(request["source"])) != request["revision"]:
            raise ValueError("The base changed after preparation. Reload the canvas.")
        async with stdio_client(StdioServerParameters(**connection)) as (incoming, outgoing):
            async with ClientSession(incoming, outgoing) as session:
                await session.initialize()
                if kind == "edit":
                    await edit_preview(session, connection, run, request, publish)
                elif kind == "references":
                    await render_refs(session, run, request, publish)
                else:
                    raise ValueError("Unsupported job kind")
    except Exception as error:
        if state.get("status") != "completed":
            cause = error
            while isinstance(cause, BaseExceptionGroup) and len(cause.exceptions) == 1:
                cause = cause.exceptions[0]
            publish("failed", state.get("stage", "connect"), error=str(cause)[:1200])
        raise


if __name__ == "__main__":
    asyncio.run(main())
