import base64
import binascii
import json
import os
import re
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PACKAGE_DIR = Path(os.environ["TUTTI_APP_PACKAGE_DIR"])
DATA_DIR = Path(os.environ["TUTTI_APP_DATA_DIR"])
LOG_DIR = Path(os.environ["TUTTI_APP_LOG_DIR"])
RUNTIME_DIR = Path(os.environ["TUTTI_APP_RUNTIME_DIR"])
# Bind the Tutti-provided host (default loopback); never bind all interfaces.
HOST = os.environ.get("TUTTI_APP_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ["TUTTI_APP_PORT"])
STATIC_DIR = PACKAGE_DIR / "static"
LOCALES_DIR = PACKAGE_DIR / "locales"
WORKSPACE_ROOT = os.environ.get("TUTTI_WORKSPACE_ROOT", "").strip()
DEFAULT_PROVIDER = "claude-code"
I18N_PLACEHOLDER = "<!--__TUTTI_I18N__-->"
# `review --image-path` accepts a caller-supplied local path, so constrain it: a
# known image type (extension + magic bytes), a size ceiling, and a location under
# the workspace/runtime/data roots (no symlinks) before the agent is told to read it.
ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
# The review handler's manifest timeout is 290s. Keep the whole operation (agent
# start + wait) under that with margin so the app never outlives the Tutti router's
# budget for the call — otherwise the caller times out while the app keeps waiting.
CLI_REVIEW_BUDGET_SECONDS = 280


def _load_manifest():
    try:
        return json.loads((PACKAGE_DIR / "tutti.app.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


_MANIFEST = _load_manifest()
APP_ID = str(_MANIFEST.get("appId") or os.environ.get("TUTTI_APP_ID") or "design-review")
APP_VERSION = str(_MANIFEST.get("version") or "0.1.0")
_LOCALIZATION = _MANIFEST.get("localizationInfo") if isinstance(_MANIFEST.get("localizationInfo"), dict) else {}
DEFAULT_LOCALE = str(_LOCALIZATION.get("defaultLocale") or "zh-CN")
SUPPORTED_LOCALES = [DEFAULT_LOCALE] + [
    str(entry.get("locale"))
    for entry in (_LOCALIZATION.get("additionalLocales") or [])
    if isinstance(entry, dict) and entry.get("locale")
]

# Localized dimension names; the agent must use these exact names and order.
DIM_NAMES = {
    "zh-CN": ["视觉层次/排版", "配色与对比", "一致性", "可用性/易用性", "品牌契合度", "转化/CTA 效果"],
    "en": ["Visual hierarchy / layout", "Color & contrast", "Consistency", "Usability", "Brand fit", "Conversion / CTA"],
}

DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


class BadRequest(ValueError):
    pass


class AgentTimeout(TimeoutError):
    pass


def health_payload():
    return {"ok": True}


def complete_payload(payload):
    prompt = build_agent_prompt(payload)
    completion_type = completion_type_for_prompt(prompt)
    session = start_agent_session(prompt)
    text = wait_for_agent_text(
        session["id"],
        accepts_text=lambda value: accepts_completion_text(value, completion_type),
    )
    if not accepts_completion_text(text, completion_type):
        raise RuntimeError(invalid_completion_message(completion_type))
    return {
        "text": normalize_completion_text(text, completion_type),
        "agentSessionId": session["id"],
        "agentProvider": session["provider"],
    }


def build_agent_prompt(payload):
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise BadRequest("缺少 messages。")
    parts = []
    image_paths = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
                elif item.get("type") == "image":
                    image_paths.append(save_image_content(item))
    prompt = "\n\n".join(part.strip() for part in parts if part and part.strip())
    if not prompt:
        raise BadRequest("缺少 prompt 内容。")
    if image_paths:
        prompt += "\n\n# 本地图片文件\n" + "\n".join(f"- {path}" for path in image_paths)
        prompt += "\n请优先读取这些本地图片文件进行视觉评审。"
    return prompt


def save_image_content(item):
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    data = str(source.get("data") or "").strip()
    media_type = str(source.get("media_type") or "image/png").strip()
    if not data:
        raise BadRequest("图片数据为空。")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadRequest("图片数据不是合法 base64。") from exc
    suffix = image_suffix(media_type)
    path = RUNTIME_DIR / f"design-review-{uuid.uuid4().hex[:12]}{suffix}"
    path.write_bytes(raw)
    return str(path)


def image_suffix(media_type):
    value = media_type.lower()
    if value == "image/jpeg":
        return ".jpg"
    if value == "image/webp":
        return ".webp"
    if value == "image/gif":
        return ".gif"
    return ".png"


def start_agent_session(prompt):
    settings = default_agent_settings()
    args = [
        "agent",
        "start",
        "--provider",
        settings["provider"],
        "--model",
        settings["model"],
        "--title",
        "设计评审",
        "--prompt",
        prompt,
        "--display-prompt",
        "执行设计评审并返回结构化 JSON",
    ]
    if settings.get("reasoningEffort"):
        args.extend(["--reasoning-effort", settings["reasoningEffort"]])
    if settings.get("permissionMode"):
        args.extend(["--permission-mode", settings["permissionMode"]])
    if WORKSPACE_ROOT:
        args.extend(["--cwd", WORKSPACE_ROOT])
    session = run_tutti_cli(args, timeout=60).get("session") or {}
    agent_session_id = clean_optional_string(session.get("id"))
    if not agent_session_id:
        raise RuntimeError("agent session was not created")
    return {
        "id": agent_session_id,
        "provider": clean_optional_string(session.get("provider")) or settings["provider"],
    }


def wait_for_agent_text(agent_session_id, timeout_seconds=300, accepts_text=None):
    accepts_text = accepts_text or is_json_review_text
    deadline = time.time() + timeout_seconds
    last_text = ""
    while time.time() < deadline:
        session = get_agent_session(agent_session_id)
        text, message_status = latest_agent_report_with_status(agent_session_id)
        if text:
            last_text = text
        if message_status == "completed" and accepts_text(text):
            return text
        status, error = terminal_agent_status(session.get("status"))
        if status == "succeeded" and accepts_text(text):
            return text
        if status in {"failed", "canceled"}:
            raise RuntimeError(error or clean_optional_string(session.get("lastError")) or "Agent 执行失败。")
        time.sleep(2)
    if accepts_text(last_text):
        return last_text
    raise AgentTimeout("等待评审 Agent 返回结果超时。")


def default_agent_provider():
    try:
        payload = run_tutti_cli(["agent", "providers"], timeout=30)
    except Exception:
        return DEFAULT_PROVIDER
    default_provider = str(payload.get("defaultProvider") or "").strip()
    providers = payload.get("providers") if isinstance(payload.get("providers"), list) else []
    ready_providers = {
        str(item.get("provider") or "").strip()
        for item in providers
        if str(item.get("status") or "").strip() in {"ready", "configured", "available"}
    }
    if default_provider and default_provider != "codex":
        return default_provider
    if DEFAULT_PROVIDER in ready_providers:
        return DEFAULT_PROVIDER
    for provider in ready_providers:
        if provider and provider != "codex":
            return provider
    if providers:
        return DEFAULT_PROVIDER
    return DEFAULT_PROVIDER


def default_agent_settings():
    provider = default_agent_provider()
    settings = {
        "provider": provider,
        "model": "",
        "reasoningEffort": "",
        "permissionMode": "",
    }
    try:
        payload = run_tutti_cli(["agent", "composer-options", "--provider", provider], timeout=30)
    except Exception:
        settings["model"] = "default"
        return settings

    effective = payload.get("effectiveSettings") if isinstance(payload.get("effectiveSettings"), dict) else {}
    model_config = payload.get("modelConfig") if isinstance(payload.get("modelConfig"), dict) else {}
    reasoning_config = payload.get("reasoningConfig") if isinstance(payload.get("reasoningConfig"), dict) else {}
    permission_config = payload.get("permissionConfig") if isinstance(payload.get("permissionConfig"), dict) else {}
    settings["model"] = clean_optional_string(effective.get("model")) or config_option_selected_value(model_config) or "default"
    settings["reasoningEffort"] = clean_optional_string(effective.get("reasoningEffort")) or config_option_selected_value(reasoning_config)
    settings["permissionMode"] = clean_optional_string(effective.get("permissionModeId")) or clean_optional_string(permission_config.get("defaultValue"))
    return settings


def config_option_selected_value(config):
    value = clean_optional_string(config.get("currentValue"))
    if value:
        return value
    value = clean_optional_string(config.get("defaultValue"))
    if value:
        return value
    options = config.get("options") if isinstance(config.get("options"), list) else []
    for option in options:
        if not isinstance(option, dict):
            continue
        value = clean_optional_string(option.get("value")) or clean_optional_string(option.get("id"))
        if value:
            return value
    return ""


def clean_optional_string(value):
    return str(value or "").strip()


def run_tutti_cli(args, timeout=60):
    command_path = os.environ.get("TUTTI_CLI", "").strip()
    if not command_path:
        raise RuntimeError("TUTTI_CLI is not configured")
    result = subprocess.run(
        [command_path, "--json", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "tutti cli command failed").strip())
    if not result.stdout.strip():
        return {}
    return json.loads(result.stdout)


def get_agent_session(agent_session_id):
    return run_tutti_cli(["agent", "get", "--session-id", agent_session_id], timeout=30).get("session") or {}


def latest_agent_report_with_status(agent_session_id):
    result = run_tutti_cli(
        ["agent", "session", "messages", "--session-id", agent_session_id, "--limit", "80"],
        timeout=30,
    )
    messages = result.get("messages") if isinstance(result.get("messages"), list) else []
    return latest_agent_report_from_messages(messages)


def latest_agent_report_from_messages(messages):
    for message in sorted(messages, key=lambda item: int(item.get("version") or item.get("id") or 0), reverse=True):
        role = str(message.get("role") or "").strip().lower()
        kind = str(message.get("kind") or "").strip().lower()
        if role in {"assistant", "agent"} and kind in {"", "text"}:
            text = extract_message_text(message.get("payload"))
            if text:
                return text, str(message.get("status") or "").strip().lower()
    return "", ""


def extract_message_text(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, list):
        parts = [extract_message_text(item) for item in value]
        text = "\n".join(part for part in parts if part)
        return text.strip() or None
    if isinstance(value, dict):
        for key in ("content", "text", "markdown", "message"):
            text = extract_message_text(value.get(key))
            if text:
                return text
        for key in ("parts", "items"):
            text = extract_message_text(value.get(key))
            if text:
                return text
    return str(value).strip() or None


def strip_json_fence(text):
    value = str(text or "").strip()
    value = re.sub(r"(?i)^```json\s*", "", value)
    value = re.sub(r"^```\s*", "", value)
    value = re.sub(r"\s*```$", "", value)
    return value.strip()


def extract_json_text(text):
    value = strip_json_fence(text)
    start = value.find("{")
    end = value.rfind("}")
    if start >= 0 and end > start:
        return value[start : end + 1]
    return value


def extract_json_array_text(text):
    value = strip_json_fence(text)
    start = value.find("[")
    end = value.rfind("]")
    if start >= 0 and end > start:
        return value[start : end + 1]
    return value


def is_json_review_text(text):
    value = extract_json_text(text)
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return False
    return isinstance(payload, dict) and isinstance(payload.get("dimensions"), list) and "overall" in payload


def is_json_array_text(text):
    value = extract_json_array_text(text)
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return False
    return isinstance(payload, list)


def completion_type_for_prompt(prompt):
    value = str(prompt or "")
    if (
        "只输出一个合法的 JSON 数组" in value
        or "请只挑出 4-6 处最主要的问题区域" in value
        or "the 4-6 most important problem areas" in value
    ):
        return "marker_json"
    if (
        "这是一张界面设计截图中被框选出来的局部区域" in value
        or "附图是一张界面设计截图里被框选出来的局部区域" in value
        or "a cropped local region of a UI design screenshot" in value
    ):
        return "plain_text"
    return "review_json"


def accepts_completion_text(text, completion_type):
    if completion_type == "marker_json":
        return is_json_array_text(text)
    if completion_type == "plain_text":
        return bool(str(text or "").strip())
    return is_json_review_text(text)


def normalize_completion_text(text, completion_type):
    if completion_type == "marker_json":
        return extract_json_array_text(text)
    if completion_type == "plain_text":
        return str(text or "").strip()
    return extract_json_text(text)


def invalid_completion_message(completion_type):
    if completion_type == "marker_json":
        return "Agent 没有返回完整的标注 JSON 数组。"
    if completion_type == "plain_text":
        return "Agent 没有返回有效的局部建议。"
    return "Agent 没有返回完整的设计评审 JSON。"


def terminal_agent_status(status):
    value = str(status or "").strip().lower()
    if value == "completed":
        return "succeeded", None
    if value == "failed":
        return "failed", None
    if value in {"canceled", "cancelled"}:
        return "canceled", "已取消。"
    return None, None


def read_json_body(handler):
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0:
        raise BadRequest("请求体不能为空。")
    try:
        return json.loads(handler.rfile.read(content_length).decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise BadRequest("请求体必须是 JSON。") from exc


def write_json(handler, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def cli_error_payload(message, code):
    """CLI error body per the Tutti CLI contract: {"error": {"code", "message"}}."""
    return {"error": {"code": code, "message": message}}


def safe_static_path(request_path):
    relative_path = unquote(request_path.split("?", 1)[0]).lstrip("/") or "index.html"
    target = (STATIC_DIR / relative_path).resolve()
    static_root = STATIC_DIR.resolve()
    if target != static_root and static_root not in target.parents:
        return None
    if not target.is_file():
        return None
    return target


def content_type_for(path):
    if path.suffix == ".html":
        return "text/html; charset=utf-8"
    if path.suffix == ".css":
        return "text/css; charset=utf-8"
    if path.suffix == ".js":
        return "application/javascript; charset=utf-8"
    if path.suffix == ".svg":
        return "image/svg+xml"
    if path.suffix == ".json":
        return "application/json; charset=utf-8"
    return "text/plain; charset=utf-8"


def read_json_body_optional(handler):
    content_length = int(handler.headers.get("Content-Length", "0") or "0")
    if content_length <= 0:
        return {}
    raw = handler.rfile.read(content_length).decode("utf-8")
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BadRequest("请求体必须是 JSON。") from exc


def normalize_strictness(value):
    text = clean_optional_string(value).lower()
    if text in {"relaxed", "loose", "lenient", "宽松"}:
        return "relaxed"
    if text in {"strict", "harsh", "严苛", "严格"}:
        return "strict"
    return "standard"


def normalize_locale(value):
    text = clean_optional_string(value).replace("_", "-").lower()
    if text.startswith("en"):
        return "en"
    if text.startswith("zh"):
        return "zh-CN"
    return DEFAULT_LOCALE if DEFAULT_LOCALE in DIM_NAMES else "zh-CN"


def build_review_prompt(url="", image_path="", strictness="standard", locale="zh-CN"):
    locale = locale if locale in DIM_NAMES else "zh-CN"
    dims = DIM_NAMES[locale]
    if locale == "en":
        tone = {
            "strict": "Apply a strict, demanding bar; score harshly and let no flaw slide.",
            "relaxed": "Lean encouraging; score generously and focus on issues that truly hurt the experience.",
        }.get(strictness, "Apply a professional, objective bar; acknowledge strengths and name problems, and spread the scores.")
        target = (
            f"Local image file to review: {image_path}\nRead this local image file and review it visually."
            if image_path
            else (
                f"Website link: {url}\n"
                "First actually open this link with your available browsing / web-fetch tools and "
                "review the real page you retrieve; do not score from memory. If you cannot reach it "
                "(intranet, localhost, login-gated, or unreachable), do not fabricate scores: set "
                '"overall" to 0 and say so in "summary".'
            )
        )
        return "\n".join([
            "# Role",
            "You are a senior design director running a strict, professional UI design review. " + tone,
            "",
            "# Task",
            "Review the provided UI design and score it across the six fixed, ordered dimensions below, then produce an actionable fix list.",
            "",
            "# Dimensions (cover all, exact names and order, do not add / rename / drop)",
            *[f"{index + 1}. {name}" for index, name in enumerate(dims)],
            "",
            "# Output format (extremely strict; violations count as failure)",
            "- Output only one valid JSON object; no prefix, suffix, comments, or markdown code fences.",
            "- Use English for every string, be specific and actionable, and obey each field's length limit.",
            "- Keep the JSON complete and compact.",
            "",
            "{",
            '  "overall": <integer 0-100>,',
            '  "summary": "<one-line verdict, <= 80 chars>",',
            '  "dimensions": [   // exactly 6 items, names and order as above',
            '    { "name": "<one of the six dimension names>", "score": <integer 0-100>, "verdict": "<one-line, <= 40 chars>", "detail": "<concrete issue or strength, <= 80 chars>" }',
            "  ],",
            '  "suggestions": [  // exactly 3 items, highest priority first',
            '    { "priority": "<high|medium|low>", "title": "<short title, <= 40 chars>", "desc": "<how to do it, <= 90 chars>" }',
            "  ]",
            "}",
            "",
            "# Subject to review",
            target,
        ])
    tone = {
        "strict": "采用严苛挑剔的标准，分数从严，绝不放过任何瑕疵。",
        "relaxed": "以鼓励为主，分数偏宽，重点指出真正影响体验的问题。",
    }.get(strictness, "采用专业客观的标准，既肯定优点也直指问题，分数要拉开差距。")
    target = (
        f"待评审设计的本地图片文件：{image_path}\n请读取该本地图片文件并基于图片进行视觉评审。"
        if image_path
        else (
            f"网站链接：{url}\n"
            "请先用你可用的浏览/网页抓取工具实际打开该链接，并以你真实获取到的页面内容为准进行评审，不要凭记忆臆测。"
            "若确实无法访问（内网、localhost、需登录或不可达），不要编造分数：将 overall 记为 0，并在 summary 中说明无法访问。"
        )
    )
    return "\n".join([
        "# 角色",
        "你是一位资深设计总监，正在做一次严格、专业的界面设计评审。" + tone,
        "",
        "# 任务",
        "评审我提供的界面设计，从下面六个【固定且有序】的维度逐一打分，并产出一份可直接执行的改进清单。",
        "",
        "# 评分维度（必须全部覆盖，name 与顺序严格如下，不得增删改名）",
        *[f"{index + 1}. {name}" for index, name in enumerate(dims)],
        "",
        "# 输出格式（极其严格，违反则视为失败）",
        "- 只输出一个合法的 JSON 对象；不要任何前后缀、说明、注释或 markdown 代码块。",
        "- 全部使用简体中文，措辞具体、可执行，严格遵守每个字段的字数上限。",
        "- 务必保证整段 JSON 完整闭合且尽量精简。",
        "",
        "{",
        '  "overall": <整数 0-100>,',
        '  "summary": "<一句话总评，≤26字>",',
        '  "dimensions": [   // 必须恰好 6 项，name 与顺序如上',
        '    { "name": "<上述六个维度名之一>", "score": <整数 0-100>, "verdict": "<一句话判断，≤12字>", "detail": "<具体问题或亮点，≤26字>" }',
        "  ],",
        '  "suggestions": [  // 恰好 3 条，按优先级从高到低排序',
        '    { "priority": "<高|中|低>", "title": "<建议标题，≤12字>", "desc": "<具体怎么做，≤28字>" }',
        "  ]",
        "}",
        "",
        "# 待评审对象",
        target,
    ])


def cli_command_input(payload):
    """Return the command input object from a CLI handler request body.

    Tutti posts an invoke envelope (``schemaVersion: tutti.app.cli.invoke.v1``)
    whose real arguments live under ``input``. Local tests and backward-compatible
    callers may post the raw input object directly. Accept both, but never require
    the raw form for Tutti runtime calls.
    """
    if not isinstance(payload, dict):
        return {}
    schema_version = str(payload.get("schemaVersion") or "")
    is_envelope = schema_version.startswith("tutti.app.cli.invoke") or (
        "input" in payload
        and any(key in payload for key in ("commandId", "path", "outputMode", "scope", "context"))
    )
    if is_envelope:
        inner = payload.get("input")
        return inner if isinstance(inner, dict) else {}
    return payload


def allowed_image_roots():
    """Directories a caller-supplied ``image-path`` may live under (resolved)."""
    roots = [RUNTIME_DIR, DATA_DIR]
    if WORKSPACE_ROOT:
        roots.insert(0, Path(WORKSPACE_ROOT))
    resolved = []
    for root in roots:
        try:
            resolved.append(root.resolve())
        except OSError:
            continue
    return resolved


def looks_like_image(path):
    """Sniff magic bytes so a non-image renamed to .png is rejected."""
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
    except OSError:
        return False
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if header.startswith(b"\xff\xd8\xff"):
        return True
    if header[:6] in (b"GIF87a", b"GIF89a"):
        return True
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return True
    return False


def validate_image_path(image_path):
    """Validate a caller-supplied image path and return its resolved location.

    The agent is instructed to read this file, so an unconstrained path would let
    any caller exfiltrate arbitrary local files. Confine it to the workspace /
    runtime / data roots, reject symlinks, and require a real image within limits.
    """
    candidate = Path(image_path)
    if not candidate.is_absolute():
        raise BadRequest("image-path must be an absolute path.")
    if candidate.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        raise BadRequest("image-path must be a PNG/JPEG/WebP/GIF image.")
    if candidate.is_symlink():
        raise BadRequest("image-path must not be a symlink.")
    try:
        real = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise BadRequest(f"image-path not found: {image_path}") from exc
    if not real.is_file():
        raise BadRequest(f"image-path not found: {image_path}")
    roots = allowed_image_roots()
    if not any(real == root or root in real.parents for root in roots):
        raise BadRequest("image-path is outside the allowed workspace/runtime/data directories.")
    size = real.stat().st_size
    if size <= 0:
        raise BadRequest("image-path is empty.")
    if size > MAX_IMAGE_BYTES:
        raise BadRequest("image-path is too large (max 20 MiB).")
    if not looks_like_image(real):
        raise BadRequest("image-path is not a valid image file.")
    return str(real)


def cli_review(payload):
    payload = cli_command_input(payload)
    if not isinstance(payload, dict):
        raise BadRequest("Invalid request body.")
    url = clean_optional_string(payload.get("url"))
    image_path = clean_optional_string(payload.get("image-path") or payload.get("imagePath"))
    strictness = normalize_strictness(payload.get("strictness"))
    locale = normalize_locale(payload.get("locale"))
    if not url and not image_path:
        raise BadRequest("Provide either url or image-path.")
    if image_path:
        image_path = validate_image_path(image_path)
    prompt = build_review_prompt(url=url, image_path=image_path, strictness=strictness, locale=locale)
    deadline = time.monotonic() + CLI_REVIEW_BUDGET_SECONDS
    session = start_agent_session(prompt)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AgentTimeout("等待评审 Agent 返回结果超时。")
    text = wait_for_agent_text(session["id"], timeout_seconds=remaining, accepts_text=is_json_review_text)
    if not is_json_review_text(text):
        raise RuntimeError(invalid_completion_message("review_json"))
    review = json.loads(extract_json_text(text))
    return {"kind": "json", "value": review}


def cli_status(payload=None):
    cli_command_input(payload)  # status takes no input; unwrap envelope defensively
    cli_configured = bool(os.environ.get("TUTTI_CLI", "").strip())
    provider = ""
    available = False
    error = ""
    if not cli_configured:
        error = "TUTTI_CLI is not configured; the review agent cannot be reached."
    else:
        try:
            result = run_tutti_cli(["agent", "providers"], timeout=20)
            provider = clean_optional_string(result.get("defaultProvider"))
            providers = result.get("providers") if isinstance(result.get("providers"), list) else []
            ready = {
                clean_optional_string(item.get("provider"))
                for item in providers
                if clean_optional_string(item.get("status")) in {"ready", "configured", "available"}
            }
            if not provider:
                provider = default_agent_provider()
            available = provider in ready
            if not available:
                error = f"agent provider '{provider or DEFAULT_PROVIDER}' is not ready."
        except Exception as exc:
            error = clean_optional_string(str(exc)) or "failed to query agent providers."
    # ``ok`` must mean "review can run", so it reflects real readiness, not just that
    # the handler responded.
    value = {
        "appId": APP_ID,
        "version": APP_VERSION,
        "provider": provider or DEFAULT_PROVIDER,
        "tuttiCliConfigured": cli_configured,
        "providerAvailable": available,
        "ok": cli_configured and available,
    }
    if error:
        value["error"] = error
    return {"kind": "json", "value": value}


def load_app_i18n():
    messages = {}
    if LOCALES_DIR.is_dir():
        for locale_dir in sorted(path for path in LOCALES_DIR.iterdir() if path.is_dir()):
            app_dict = locale_dir / "app.json"
            if app_dict.is_file():
                try:
                    messages[locale_dir.name] = json.loads(app_dict.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
    return messages


def render_index_html():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    bundle = {
        "messages": load_app_i18n(),
        "defaultLocale": DEFAULT_LOCALE,
        "locales": SUPPORTED_LOCALES,
    }
    script = "<script>window.__TUTTI_I18N__=" + json.dumps(bundle, ensure_ascii=False) + ";</script>"
    return html.replace(I18N_PLACEHOLDER, script)


def safe_locales_path(request_path):
    relative_path = unquote(request_path.split("?", 1)[0]).lstrip("/")
    target = (PACKAGE_DIR / relative_path).resolve()
    locales_root = LOCALES_DIR.resolve()
    if target != locales_root and locales_root not in target.parents:
        return None
    if not target.is_file():
        return None
    return target


class ReviewHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            write_json(self, 200, health_payload())
            return
        if self.path.split("?", 1)[0].startswith("/locales/"):
            self.serve_file(safe_locales_path(self.path))
            return
        self.serve_static()

    def do_POST(self):
        if self.path == "/api/complete":
            self.handle_json(complete_payload, read_json_body, "评审服务异常。")
            return
        if self.path == "/tutti/cli/review":
            self.handle_cli(cli_review, "design-review review failed.")
            return
        if self.path == "/tutti/cli/status":
            self.handle_cli(cli_status, "design-review status failed.")
            return
        write_json(self, 404, {"error": "Not found"})

    def handle_json(self, action, read_body, fallback_error):
        try:
            write_json(self, 200, action(read_body(self)))
        except BadRequest as exc:
            write_json(self, 400, {"error": str(exc)})
        except AgentTimeout as exc:
            write_json(self, 504, {"error": str(exc)})
        except Exception as exc:
            write_json(self, 500, {"error": str(exc) or fallback_error})

    def handle_cli(self, action, fallback_error):
        # CLI handlers follow the Tutti CLI contract: errors are a non-2xx status with
        # an {"error": {"code", "message"}} body (Tutti surfaces error.message), never a
        # bare {"error": "<string>"}, so machine callers can parse failures uniformly.
        try:
            write_json(self, 200, action(read_json_body_optional(self)))
        except BadRequest as exc:
            write_json(self, 400, cli_error_payload(str(exc) or fallback_error, "invalid_input"))
        except AgentTimeout as exc:
            write_json(self, 504, cli_error_payload(str(exc) or fallback_error, "timeout"))
        except Exception as exc:
            write_json(self, 500, cli_error_payload(str(exc) or fallback_error, "internal_error"))

    def serve_static(self):
        target = safe_static_path(self.path)
        if not target:
            write_json(self, 404, {"error": "Not found"})
            return
        if target == (STATIC_DIR / "index.html").resolve():
            self.write_bytes(render_index_html().encode("utf-8"), content_type_for(target))
            return
        self.serve_file(target)

    def serve_file(self, target):
        if not target:
            write_json(self, 404, {"error": "Not found"})
            return
        self.write_bytes(target.read_bytes(), content_type_for(target))

    def write_bytes(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


def main():
    server = ThreadingHTTPServer((HOST, PORT), ReviewHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
