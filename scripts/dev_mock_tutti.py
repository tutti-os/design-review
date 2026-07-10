#!/usr/bin/env python3
"""Mock `$TUTTI_CLI` for browser-only development (stage 1).

A plain browser has no Tutti agent runtime, so the real review never runs. This
stub stands in for the `tutti` CLI that `server.py` shells out to, returning
canned-but-well-shaped agent output so the whole UI — scorecard, image markers,
and per-region advice — works end to end in a normal browser.

It is wired in by `scripts/dev.py --mock-agent`; never shipped in the package.

The CLI is invoked once per step (`agent start`, then `agent get` / `agent
session messages`), so it is stateless across calls. To remember what kind of
answer to give, `agent start` classifies the prompt and encodes the answer shape
into the returned session id (e.g. `sess-review-en`); later calls read it back.
"""

from __future__ import annotations

import json
import sys


def arg_value(args, name):
    for i, value in enumerate(args):
        if value == name and i + 1 < len(args):
            return args[i + 1]
    return ""


def classify(prompt):
    """Return (kind, locale) mirroring server.completion_type_for_prompt."""
    english_markers = (
        "You are a senior design director",
        "Output only one valid JSON object",
        "the 4-6 most important problem areas",
        "cropped local region of a UI",
        "senior designer looking at this UI",
    )
    locale = "en" if any(marker in prompt for marker in english_markers) else "zh"
    if (
        "只输出一个合法的 JSON 数组" in prompt
        or "请只挑出 4-6 处最主要的问题区域" in prompt
        or "the 4-6 most important problem areas" in prompt
    ):
        return "marker", locale
    if (
        "被框选出来的局部区域" in prompt
        or "a cropped local region of a UI design screenshot" in prompt
    ):
        return "text", locale
    return "review", locale


REVIEW = {
    "zh": {
        "overall": 78,
        "summary": "层次清楚，转化偏弱",
        "dimensions": [
            {"name": "视觉层次/排版", "score": 84, "verdict": "层次清楚", "detail": "首屏重点明确，留白舒适"},
            {"name": "配色与对比", "score": 80, "verdict": "对比达标", "detail": "正文对比足够，次要信息略灰"},
            {"name": "一致性", "score": 76, "verdict": "基本一致", "detail": "按钮圆角与间距偶有出入"},
            {"name": "可用性/易用性", "score": 79, "verdict": "操作顺畅", "detail": "主流程清晰，错误态可加强"},
            {"name": "品牌契合度", "score": 81, "verdict": "调性统一", "detail": "字体与色彩贴合品牌气质"},
            {"name": "转化/CTA 效果", "score": 68, "verdict": "主按钮偏弱", "detail": "CTA 与周边竞争，吸引力不足"},
        ],
        "suggestions": [
            {"priority": "高", "title": "强化主 CTA", "desc": "提高对比并减少同屏竞争按钮"},
            {"priority": "中", "title": "统一组件规范", "desc": "对齐圆角/间距，建一套基础 token"},
            {"priority": "低", "title": "加强次要信息对比", "desc": "灰度文本再提一档，保证可读"},
        ],
    },
    "en": {
        "overall": 78,
        "summary": "Clear hierarchy, weak conversion",
        "dimensions": [
            {"name": "Visual hierarchy / layout", "score": 84, "verdict": "Clear focus", "detail": "Hero reads well, comfortable spacing"},
            {"name": "Color & contrast", "score": 80, "verdict": "Meets AA", "detail": "Body contrast fine, secondary a bit gray"},
            {"name": "Consistency", "score": 76, "verdict": "Mostly aligned", "detail": "Radii and spacing drift slightly"},
            {"name": "Usability", "score": 79, "verdict": "Smooth flow", "detail": "Main path clear; error states thin"},
            {"name": "Brand fit", "score": 81, "verdict": "On tone", "detail": "Type and color match brand voice"},
            {"name": "Conversion / CTA", "score": 68, "verdict": "Weak CTA", "detail": "Primary action competes with siblings"},
        ],
        "suggestions": [
            {"priority": "high", "title": "Strengthen the primary CTA", "desc": "Raise contrast, cut competing on-screen buttons"},
            {"priority": "medium", "title": "Unify component rules", "desc": "Align radii/spacing with base design tokens"},
            {"priority": "low", "title": "Lift secondary text contrast", "desc": "Darken gray text one step for readability"},
        ],
    },
}

MARKERS = {
    "zh": [
        {"box": {"x": 0.06, "y": 0.04, "w": 0.4, "h": 0.12}, "dim": "视觉层次/排版", "severity": "中", "note": "标题与副标题间距偏大"},
        {"box": {"x": 0.62, "y": 0.05, "w": 0.3, "h": 0.08}, "dim": "转化/CTA 效果", "severity": "高", "note": "主按钮对比不足"},
        {"box": {"x": 0.08, "y": 0.55, "w": 0.84, "h": 0.18}, "dim": "配色与对比", "severity": "中", "note": "正文灰度偏低"},
        {"box": {"x": 0.1, "y": 0.8, "w": 0.5, "h": 0.1}, "dim": "一致性", "severity": "低", "note": "圆角与其它卡片不一致"},
    ],
    "en": [
        {"box": {"x": 0.06, "y": 0.04, "w": 0.4, "h": 0.12}, "dim": "Visual hierarchy / layout", "severity": "medium", "note": "Title-subtitle gap too large"},
        {"box": {"x": 0.62, "y": 0.05, "w": 0.3, "h": 0.08}, "dim": "Conversion / CTA", "severity": "high", "note": "Primary button low contrast"},
        {"box": {"x": 0.08, "y": 0.55, "w": 0.84, "h": 0.18}, "dim": "Color & contrast", "severity": "medium", "note": "Body text too light"},
        {"box": {"x": 0.1, "y": 0.8, "w": 0.5, "h": 0.1}, "dim": "Consistency", "severity": "low", "note": "Card radius inconsistent"},
    ],
}

TEXT = {
    "zh": "这块区域的对比偏弱，建议把主按钮背景加深一档、文字与背景对比拉到 4.5:1 以上，并把点击热区高度提到 44px 左右，更易点中。",
    "en": "Contrast here is weak. Darken the primary button one step, push text/background contrast past 4.5:1, and raise the tap target to ~44px so it is easier to hit.",
}


def message_payload(kind, locale):
    if kind == "marker":
        return json.dumps(MARKERS[locale], ensure_ascii=False)
    if kind == "text":
        return TEXT[locale]
    return json.dumps(REVIEW[locale], ensure_ascii=False)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))
    raise SystemExit(0)


def main():
    args = [value for value in sys.argv[1:] if value != "--json"]

    if args[:2] == ["agent", "providers"]:
        emit({
            "schemaVersion": 2,
            "defaultProviderId": "claude-code",
            "providers": [{"providerId": "claude-code", "availability": {"status": "available"}}],
        })
    if args[:2] == ["agent", "start"]:
        kind, locale = classify(arg_value(args, "--prompt"))
        emit({"session": {"agentSessionId": f"sess-{kind}-{locale}", "provider": "claude-code"}})
    if args[:2] == ["agent", "get"]:
        emit({"session": {"id": arg_value(args, "--session-id"), "status": "completed"}})
    if args[:2] == ["agent", "session-summary"]:
        session_id = arg_value(args, "--session-id")
        parts = session_id.split("-")  # sess-<kind>-<locale>
        kind = parts[1] if len(parts) > 1 else "review"
        locale = parts[2] if len(parts) > 2 else "zh"
        emit({"messages": [{"role": "assistant", "kind": "text", "version": 1, "status": "completed", "payload": message_payload(kind, locale)}]})

    emit({})


if __name__ == "__main__":
    main()
