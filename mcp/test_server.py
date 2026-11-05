"""Focused adapter checks. No desktop or production media is opened."""
import asyncio
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("canvas_mcp_adapter", Path(__file__).with_name("server.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.registry = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"PRODUCTION_CANVAS_MCP_REGISTRY": str(self.registry)})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def row(self, origin="http://127.0.0.1:12345"):
        return {"schema": adapter.SCHEMA, "instance_id": "a" * 32, "pid": os.getpid(),
                "origin": origin, "token": "b" * 64, "profile": str(self.registry / "profile"),
                "version": "1.5.0", "build_commit": "test"}

    def save(self, row):
        path = self.registry / "test.json"
        path.write_text(json.dumps(row), encoding="utf8")
        return path

    def test_descriptor_accepts_loopback_and_hides_credentials(self):
        row = self.row()
        self.save(row)
        with patch.object(adapter, "request", return_value={"ready": True}):
            result = adapter.list_instances()
        self.assertEqual(result[0]["instance_id"], row["instance_id"])
        self.assertNotIn(row["token"], json.dumps(result))

    def test_descriptor_rejects_external_and_ambiguous_origins(self):
        for origin in ("https://127.0.0.1:12345", "http://localhost:12345", "http://example.com:12345",
                       "http://127.0.0.1:12345/x", "http://u:p@127.0.0.1:12345", "http://127.0.0.1"):
            with self.subTest(origin=origin):
                path = self.save(self.row(origin))
                with self.assertRaises(ValueError):
                    adapter.read_descriptor(path, self.registry)

    def test_malformed_descriptors_do_not_break_discovery(self):
        self.save({"schema": "other"})
        (self.registry / "broken.json").write_text("{", encoding="utf8")
        (self.registry / "array.json").write_text("[]", encoding="utf8")
        self.assertEqual(adapter.descriptors(), [])
        with self.assertRaises(ValueError):
            adapter.descriptor("a" * 32)

    def test_version_guard_and_note_id_are_required(self):
        with self.assertRaises(ValueError):
            adapter.guard("test", "bad", "b" * 64)
        with self.assertRaises(ValueError):
            adapter.save_direction("a" * 32, "test", "b" * 64, "c" * 64, "note", "not-an-id")
        with self.assertRaises(ValueError):
            adapter.seek_frame("a" * 32, "test", "b" * 64, "c" * 64, -1)

    def test_authenticated_http_and_error_do_not_expose_token(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                received.append((self.headers.get("X-Canvas-MCP"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                payload = json.dumps({"error": "Version changed", "code": "STALE_VERSION"}).encode()
                self.send_response(409)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            row = self.row(f"http://127.0.0.1:{server.server_port}")
            with self.assertRaisesRegex(RuntimeError, "Canvas 409: Version changed") as caught:
                adapter.request(row, "/api/mcp/command", {"command": "state"})
            self.assertEqual(received, [(row["token"], {"command": "state"})])
            self.assertNotIn(row["token"], str(caught.exception))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_capture_returns_an_image_content_block(self):
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=")
        with patch.object(adapter, "command", return_value={"png_base64": base64.b64encode(png).decode(), "state": {"displayed_frame": 12}}):
            result = adapter.capture_frame("a" * 32, "test", "b" * 64, "c" * 64)
        self.assertEqual(result[0].type, "text")
        self.assertEqual(result[1].type, "image")
        self.assertEqual(result[1].mimeType, "image/png")

    def test_import_uses_the_guarded_project_route(self):
        manifest = self.registry / "project.json"
        manifest.write_text("{}")
        with patch.object(adapter, "command", return_value={"imported": True}) as imported:
            result = adapter.import_project("a" * 32, str(manifest))
        imported.assert_called_once_with("a" * 32, "import_project", manifest_path=str(manifest.resolve()))
        self.assertTrue(result["imported"])
        with self.assertRaises(ValueError):
            adapter.import_project("a" * 32, "relative.json")

    def test_tool_inventory_and_annotations(self):
        tools = asyncio.run(adapter.mcp.list_tools())
        self.assertEqual(len(tools), 14)
        self.assertTrue(next(tool for tool in tools if tool.name == "list_instances").annotations.readOnlyHint)
        self.assertFalse(next(tool for tool in tools if tool.name == "save_direction").annotations.readOnlyHint)
        self.assertFalse(any("approve" in tool.name or "delete" in tool.name for tool in tools))


if __name__ == "__main__":
    unittest.main()
