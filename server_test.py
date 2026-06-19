import base64
import importlib.util
import json
import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock


REVIEW_JSON = json.dumps(
    {
        "overall": 82,
        "summary": "层次清楚但转化弱",
        "dimensions": [
            {"name": "视觉层次/排版", "score": 82, "verdict": "层次清楚", "detail": "首屏重点明确"},
        ],
        "suggestions": [
            {"priority": "高", "title": "强化主按钮", "desc": "提高对比并减少干扰"},
        ],
    },
    ensure_ascii=False,
)

MARKER_JSON = json.dumps(
    [
        {
            "box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
            "dim": "视觉层次/排版",
            "severity": "高",
            "note": "主按钮弱",
        }
    ],
    ensure_ascii=False,
)


def load_server_module(temp_root):
    package_dir = Path(__file__).resolve().parent
    os.environ["TUTTI_APP_PACKAGE_DIR"] = str(package_dir)
    os.environ["TUTTI_APP_DATA_DIR"] = str(temp_root / "data")
    os.environ["TUTTI_APP_LOG_DIR"] = str(temp_root / "logs")
    os.environ["TUTTI_APP_RUNTIME_DIR"] = str(temp_root / "runtime")
    os.environ["TUTTI_WORKSPACE_ID"] = "workspace-1"
    os.environ["TUTTI_WORKSPACE_ROOT"] = str(temp_root / "workspace")
    os.environ["TUTTI_APP_PORT"] = "0"
    os.environ["TUTTI_CLI"] = "/usr/local/bin/tutti"

    spec = importlib.util.spec_from_file_location(
        f"design_review_server_test_{id(temp_root)}",
        package_dir / "server.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeRequestHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.headers[name] = value

    def end_headers(self):
        pass

    def body_json(self):
        self.wfile.seek(0)
        return json.loads(self.wfile.read().decode("utf-8"))


class ReviewServerTest(unittest.TestCase):
    def test_health_payload_reports_ok(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            self.assertEqual(module.health_payload(), {"ok": True})

    def test_build_agent_prompt_accepts_dc_text_message(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            prompt = module.build_agent_prompt(
                {"messages": [{"role": "user", "content": "请评审 https://example.com 并返回 JSON"}]}
            )

            self.assertIn("https://example.com", prompt)
            self.assertIn("返回 JSON", prompt)

    def test_build_agent_prompt_saves_dc_image_message(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            prompt = module.build_agent_prompt(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "image/png",
                                        "data": base64.b64encode(b"image-bytes").decode("ascii"),
                                    },
                                },
                                {"type": "text", "text": "请基于截图评审"},
                            ],
                        }
                    ]
                }
            )

            self.assertIn("请基于截图评审", prompt)
            self.assertIn("本地图片文件", prompt)
            image_path = Path(prompt.split("- ", 1)[1].split("\n", 1)[0])
            self.assertEqual(image_path.read_bytes(), b"image-bytes")

    def test_default_agent_provider_uses_configured_default_even_when_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            def fake_run_tutti_cli(args, timeout=60):
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "claude-code",
                        "providers": [
                            {"provider": "claude-code", "status": "unavailable"},
                            {"provider": "codex", "status": "unavailable"},
                        ],
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                self.assertEqual(module.default_agent_provider(), "claude-code")

    def test_default_agent_provider_does_not_fall_back_to_codex_when_cli_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with mock.patch.object(module, "run_tutti_cli", side_effect=RuntimeError("provider query failed")):
                self.assertEqual(module.default_agent_provider(), "claude-code")

    def test_default_agent_provider_does_not_use_unavailable_codex_default(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            def fake_run_tutti_cli(args, timeout=60):
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "codex",
                        "providers": [
                            {"provider": "claude-code", "status": "available"},
                            {"provider": "codex", "status": "unavailable"},
                        ],
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                self.assertEqual(module.default_agent_provider(), "claude-code")

    def test_start_agent_session_uses_default_provider_settings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            calls = []

            def fake_run_tutti_cli(args, timeout=60):
                calls.append(args)
                if args == ["agent", "providers"]:
                    return {"defaultProvider": "claude-code", "providers": []}
                if args == ["agent", "composer-options", "--provider", "claude-code"]:
                    return {
                        "effectiveSettings": {
                            "model": "sonnet",
                            "permissionModeId": "auto",
                            "reasoningEffort": "high",
                        }
                    }
                if args[:2] == ["agent", "start"]:
                    return {"session": {"id": "session-1", "provider": "claude-code"}}
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                session = module.start_agent_session("prompt text")

            self.assertEqual(session, {"id": "session-1", "provider": "claude-code"})
            start_args = calls[-1]
            self.assertEqual(start_args[:4], ["agent", "start", "--provider", "claude-code"])
            self.assertEqual(start_args[start_args.index("--model") + 1], "sonnet")
            self.assertEqual(start_args[start_args.index("--reasoning-effort") + 1], "high")
            self.assertEqual(start_args[start_args.index("--permission-mode") + 1], "auto")
            self.assertNotIn("--show", start_args)

    def test_wait_for_agent_text_ignores_tool_message_until_json_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            messages = iter(
                [
                    (
                        "Tool: WebFetch",
                        "completed",
                    ),
                    (
                        REVIEW_JSON,
                        "completed",
                    ),
                ]
            )

            with (
                mock.patch.object(module, "get_agent_session", return_value={"status": "created"}),
                mock.patch.object(module, "latest_agent_report_with_status", side_effect=lambda session_id: next(messages)),
                mock.patch.object(module.time, "sleep", return_value=None),
            ):
                self.assertEqual(module.wait_for_agent_text("session-1"), REVIEW_JSON)

    def test_complete_payload_returns_agent_json_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "session-1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value=f"```json\n{REVIEW_JSON}\n```"),
            ):
                payload = module.complete_payload({"messages": [{"role": "user", "content": "prompt"}]})

            self.assertEqual(payload["text"], REVIEW_JSON)
            self.assertEqual(payload["agentSessionId"], "session-1")
            self.assertEqual(payload["agentProvider"], "claude-code")

    def test_complete_payload_returns_marker_json_array_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            marker_prompt = "请只挑出 4-6 处最主要的问题区域。\n只输出一个合法的 JSON 数组。"

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "session-1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value=f"```json\n{MARKER_JSON}\n```"),
            ):
                payload = module.complete_payload({"messages": [{"role": "user", "content": marker_prompt}]})

            self.assertEqual(payload["text"], MARKER_JSON)
            self.assertEqual(payload["agentSessionId"], "session-1")
            self.assertEqual(payload["agentProvider"], "claude-code")

    def test_complete_payload_returns_annotation_plain_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            annotation_prompt = (
                "这是一张界面设计截图中被框选出来的局部区域。"
                "请作为资深设计师给出具体建议，用简体中文纯文本回答。"
            )

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "session-1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value="建议提高按钮对比，并收紧上下间距。"),
            ):
                payload = module.complete_payload({"messages": [{"role": "user", "content": annotation_prompt}]})

            self.assertEqual(payload["text"], "建议提高按钮对比，并收紧上下间距。")
            self.assertEqual(payload["agentSessionId"], "session-1")
            self.assertEqual(payload["agentProvider"], "claude-code")

    def test_complete_payload_returns_annotation_plain_text_for_current_prompt(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            annotation_prompt = (
                "附图是一张界面设计截图里被框选出来的局部区域，你现在已经看到了它。"
                "用户对这块区域的问题/批注是：「输入框是不是太宽了」。"
                "请作为资深设计师直接回答这个问题，并给出具体、可执行的修改建议。"
            )

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "session-1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value="输入框确实偏宽，建议限制最大宽度并增强聚焦态。"),
            ):
                payload = module.complete_payload({"messages": [{"role": "user", "content": annotation_prompt}]})

            self.assertEqual(payload["text"], "输入框确实偏宽，建议限制最大宽度并增强聚焦态。")
            self.assertEqual(payload["agentSessionId"], "session-1")
            self.assertEqual(payload["agentProvider"], "claude-code")

    def test_complete_payload_rejects_non_json_agent_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "session-1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value="不是 JSON"),
            ):
                with self.assertRaisesRegex(RuntimeError, "完整的设计评审 JSON"):
                    module.complete_payload({"messages": [{"role": "user", "content": "prompt"}]})

    def test_safe_static_path_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            self.assertIsNone(module.safe_static_path("/../server.py"))

    def test_json_response_sets_content_type(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            handler = FakeRequestHandler()

            module.write_json(handler, 200, {"ok": True})

            self.assertEqual(handler.status, 200)
            self.assertEqual(handler.headers["Content-Type"], "application/json; charset=utf-8")
            self.assertEqual(handler.body_json(), {"ok": True})

    def test_build_review_prompt_uses_localized_dimensions_and_target(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            zh = module.build_review_prompt(url="https://example.com", strictness="strict", locale="zh-CN")
            self.assertIn("视觉层次/排版", zh)
            self.assertIn("转化/CTA 效果", zh)
            self.assertIn("网站链接：https://example.com", zh)

            en = module.build_review_prompt(image_path="/tmp/shot.png", strictness="relaxed", locale="en")
            self.assertIn("Visual hierarchy / layout", en)
            self.assertIn("Conversion / CTA", en)
            self.assertIn("/tmp/shot.png", en)

    def test_normalize_strictness_and_locale(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            self.assertEqual(module.normalize_strictness("严苛"), "strict")
            self.assertEqual(module.normalize_strictness("relaxed"), "relaxed")
            self.assertEqual(module.normalize_strictness("anything"), "standard")
            self.assertEqual(module.normalize_locale("en-US"), "en")
            self.assertEqual(module.normalize_locale("zh_Hans"), "zh-CN")

    def test_cli_review_returns_command_output_envelope(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "s1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value=f"```json\n{REVIEW_JSON}\n```"),
            ):
                output = module.cli_review({"url": "https://example.com", "locale": "zh-CN"})

            self.assertEqual(output["kind"], "json")
            self.assertEqual(output["value"]["overall"], 82)
            self.assertEqual(output["value"]["dimensions"][0]["name"], "视觉层次/排版")

    def test_cli_review_requires_url_or_image(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with self.assertRaises(module.BadRequest):
                module.cli_review({})

    def test_cli_command_input_unwraps_envelope_and_passes_raw_through(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            envelope = {
                "schemaVersion": "tutti.app.cli.invoke.v1",
                "commandId": "design-review.review",
                "appId": "design-review",
                "scope": "design-review",
                "path": ["review"],
                "workspaceId": "workspace-1",
                "input": {"url": "https://example.com", "locale": "en"},
                "outputMode": "json",
                "context": {"source": "cli", "parentCommandId": None},
            }
            self.assertEqual(
                module.cli_command_input(envelope),
                {"url": "https://example.com", "locale": "en"},
            )
            # Raw input (local test / back-compat) is passed through unchanged.
            self.assertEqual(
                module.cli_command_input({"url": "https://example.com"}),
                {"url": "https://example.com"},
            )
            # An envelope with a missing/empty input resolves to an empty object.
            self.assertEqual(
                module.cli_command_input({"schemaVersion": "tutti.app.cli.invoke.v1"}),
                {},
            )

    def test_cli_review_accepts_invoke_envelope(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "s1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", return_value=f"```json\n{REVIEW_JSON}\n```"),
            ):
                output = module.cli_review(
                    {
                        "schemaVersion": "tutti.app.cli.invoke.v1",
                        "commandId": "design-review.review",
                        "scope": "design-review",
                        "path": ["review"],
                        "input": {"url": "https://example.com", "locale": "zh-CN"},
                        "outputMode": "json",
                    }
                )

            self.assertEqual(output["kind"], "json")
            self.assertEqual(output["value"]["overall"], 82)
            self.assertEqual(output["value"]["dimensions"][0]["name"], "视觉层次/排版")

    def test_cli_review_envelope_with_blank_input_requires_url_or_image(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with self.assertRaises(module.BadRequest):
                module.cli_review(
                    {
                        "schemaVersion": "tutti.app.cli.invoke.v1",
                        "scope": "design-review",
                        "path": ["review"],
                        "input": {},
                    }
                )

    def test_cli_status_accepts_invoke_envelope(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            def fake_run_tutti_cli(args, timeout=60):
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "claude-code",
                        "providers": [{"provider": "claude-code", "status": "available"}],
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                output = module.cli_status(
                    {
                        "schemaVersion": "tutti.app.cli.invoke.v1",
                        "commandId": "design-review.status",
                        "scope": "design-review",
                        "path": ["status"],
                        "input": {},
                        "outputMode": "json",
                    }
                )

            self.assertEqual(output["kind"], "json")
            self.assertTrue(output["value"]["ok"])
            self.assertEqual(output["value"]["provider"], "claude-code")
            self.assertTrue(output["value"]["providerAvailable"])

    def test_cli_status_reports_provider_and_app_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            def fake_run_tutti_cli(args, timeout=60):
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "claude-code",
                        "providers": [{"provider": "claude-code", "status": "available"}],
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                output = module.cli_status({})

            self.assertEqual(output["kind"], "json")
            self.assertTrue(output["value"]["ok"])
            self.assertEqual(output["value"]["appId"], "design-review")
            self.assertEqual(output["value"]["version"], "0.1.0")
            self.assertEqual(output["value"]["provider"], "claude-code")
            self.assertTrue(output["value"]["providerAvailable"])

    def test_render_index_html_injects_i18n_bundle(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            html = module.render_index_html()

            self.assertIn("window.__TUTTI_I18N__", html)
            self.assertIn("zh-CN", html)
            self.assertIn("\"defaultLocale\"", html)
            self.assertNotIn("<!--__TUTTI_I18N__-->", html)

    def test_validate_image_path_accepts_image_under_runtime_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            img = module.RUNTIME_DIR / "shot.png"
            img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

            self.assertEqual(module.validate_image_path(str(img)), str(img.resolve()))

    def test_validate_image_path_rejects_path_outside_allowed_roots(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            outside = Path(temp_dir) / "outside.png"
            outside.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

            with self.assertRaises(module.BadRequest):
                module.validate_image_path(str(outside))

    def test_validate_image_path_rejects_non_image_content(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            fake = module.RUNTIME_DIR / "notreally.png"
            fake.write_bytes(b"this is plainly not an image")

            with self.assertRaises(module.BadRequest):
                module.validate_image_path(str(fake))

    def test_validate_image_path_rejects_disallowed_extension(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            secret = module.RUNTIME_DIR / "secret.txt"
            secret.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

            with self.assertRaises(module.BadRequest):
                module.validate_image_path(str(secret))

    def test_validate_image_path_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            real = module.DATA_DIR / "real.png"
            real.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
            link = module.RUNTIME_DIR / "link.png"
            try:
                link.symlink_to(real)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks not supported on this platform")

            with self.assertRaises(module.BadRequest):
                module.validate_image_path(str(link))

    def test_cli_review_keeps_wait_within_manifest_budget(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            captured = {}

            def fake_wait(session_id, timeout_seconds=300, accepts_text=None):
                captured["timeout"] = timeout_seconds
                return REVIEW_JSON

            with (
                mock.patch.object(module, "start_agent_session", return_value={"id": "s1", "provider": "claude-code"}),
                mock.patch.object(module, "wait_for_agent_text", side_effect=fake_wait),
            ):
                module.cli_review({"url": "https://example.com", "locale": "zh-CN"})

            self.assertIn("timeout", captured)
            self.assertGreater(captured["timeout"], 0)
            self.assertLessEqual(captured["timeout"], module.CLI_REVIEW_BUDGET_SECONDS)

    def test_cli_status_not_ok_when_provider_unavailable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            def fake_run_tutti_cli(args, timeout=60):
                if args == ["agent", "providers"]:
                    return {
                        "defaultProvider": "claude-code",
                        "providers": [{"provider": "claude-code", "status": "unavailable"}],
                    }
                raise AssertionError(f"unexpected CLI args: {args!r}")

            with mock.patch.object(module, "run_tutti_cli", fake_run_tutti_cli):
                output = module.cli_status({})

            self.assertFalse(output["value"]["ok"])
            self.assertFalse(output["value"]["providerAvailable"])
            self.assertTrue(output["value"]["tuttiCliConfigured"])
            self.assertIn("error", output["value"])

    def test_cli_status_not_ok_when_cli_not_configured(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))

            with mock.patch.dict(module.os.environ, {"TUTTI_CLI": ""}):
                output = module.cli_status({})

            self.assertFalse(output["value"]["ok"])
            self.assertFalse(output["value"]["tuttiCliConfigured"])
            self.assertIn("error", output["value"])

    def test_handle_cli_wraps_error_in_contract_error_body(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            module = load_server_module(Path(temp_dir))
            handler = FakeRequestHandler()
            handler.headers = {"Content-Length": "0"}
            handler.rfile = BytesIO(b"")

            def failing(_payload):
                raise module.BadRequest("Provide either url or image-path.")

            module.ReviewHandler.handle_cli(handler, failing, "fallback")

            self.assertEqual(handler.status, 400)
            body = handler.body_json()
            self.assertNotIn("kind", body)
            self.assertEqual(body["error"]["code"], "invalid_input")
            self.assertIn("url or image-path", body["error"]["message"])


if __name__ == "__main__":
    unittest.main()
