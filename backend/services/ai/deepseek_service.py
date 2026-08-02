from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parents[2]
PROMPT_PATH = BASE_DIR / "prompts" / "business_video_prompt.txt"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-v4-flash"
PLAN_TYPES = ("老板故事型", "产品展示型", "本地流量型")
LOGGER = logging.getLogger(__name__)


class DeepSeekServiceError(Exception):
    """Raised when DeepSeek cannot return a valid generation result."""


def _log_raw_content(content: Any) -> None:
    message = f"AI 原始返回内容：\n{content}"
    LOGGER.info(message)
    print(message, flush=True)


def _load_prompt() -> str:
    try:
        return PROMPT_PATH.read_text(encoding="utf-8")
    except OSError as error:
        raise DeepSeekServiceError("Prompt 模板读取失败") from error


def _first_value(payload: dict[str, Any], *keys: str) -> Any:
    normalized_payload = {
        re.sub(r"[\s_\-:：，,。·/]+", "", str(key)).lower(): value
        for key, value in payload.items()
    }
    for key in keys:
        if payload.get(key) not in (None, ""):
            return payload[key]
        normalized_key = re.sub(r"[\s_\-:：，,。·/]+", "", key).lower()
        if normalized_payload.get(normalized_key) not in (None, ""):
            return normalized_payload[normalized_key]
    return None


def _json_candidates(content: str) -> list[str]:
    """Return likely JSON fragments from plain, fenced, or explanatory output."""
    text = content.strip().lstrip("\ufeff")
    candidates = [text]
    for match in re.finditer(r"```(?:json|JSON)?\s*(.*?)\s*```", text, flags=re.DOTALL):
        candidates.insert(0, match.group(1).strip())

    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character not in "[{":
            continue
        try:
            _, end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        candidates.append(text[index : index + end].strip())
        break
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _parse_model_content(content: Any) -> Any:
    """Parse the model message while tolerating Markdown and surrounding prose."""
    if isinstance(content, dict):
        return content
    if isinstance(content, list):
        if all(isinstance(part, dict) and "text" in part for part in content):
            content = "".join(str(part.get("text", "")) for part in content)
        else:
            return content
    if not isinstance(content, str):
        raise DeepSeekServiceError("AI 服务返回内容格式不正确")

    for candidate in _json_candidates(content):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise DeepSeekServiceError("AI 服务返回内容格式不正确")


def _extract_plans(payload: Any) -> Any:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, str):
        try:
            return _extract_plans(json.loads(payload))
        except json.JSONDecodeError:
            return None
    if not isinstance(payload, dict):
        return None

    raw_plans = _first_value(payload, "plans", "video_plans", "方案", "方案列表", "短视频方案")
    if raw_plans is not None:
        extracted = _extract_plans(raw_plans)
        if extracted is not None:
            return extracted

    for container_key in ("data", "result", "output", "内容"):
        nested = _first_value(payload, container_key)
        nested_plans = _extract_plans(nested)
        if nested_plans is not None:
            return nested_plans

    indexed_plans: dict[int, Any] = {}
    for key, value in payload.items():
        normalized_key = re.sub(r"[\s_\-:：，,。·/]+", "", str(key)).lower()
        match = re.fullmatch(r"(?:方案|plan)?([123])", normalized_key)
        if match:
            indexed_plans[int(match.group(1))] = value
        elif normalized_key in {"a", "b", "c"}:
            indexed_plans[{"a": 1, "b": 2, "c": 3}[normalized_key]] = value

    if indexed_plans:
        return [indexed_plans[index] for index in sorted(indexed_plans)]

    named_plans = [_first_value(payload, plan_type, plan_type.replace("型", "")) for plan_type in PLAN_TYPES]
    return [plan for plan in named_plans if isinstance(plan, dict)] or None


def _normalize_result(payload: Any) -> dict[str, Any]:
    raw_plans = _extract_plans(payload)
    if not isinstance(raw_plans, list):
        raise DeepSeekServiceError("AI 返回的方案数量不是 3 套")
    if not raw_plans:
        return {"plans": []}

    # Keep the MVP contract stable while allowing one or two valid plans to be
    # displayed when the model returns fewer than three.
    raw_plans = list(raw_plans[:3])

    plans: list[dict[str, Any]] = []
    for index, raw_plan in enumerate(raw_plans):
        if not isinstance(raw_plan, dict):
            raw_plan = {}

        fallback_theme = f"{PLAN_TYPES[index]}短视频方案"
        theme = str(_first_value(raw_plan, "theme", "video_theme", "视频主题", "今日短视频主题", "主题") or fallback_theme)
        title = str(_first_value(raw_plan, "title", "video_title", "视频标题", "推荐标题", "发布标题") or theme)
        hook = str(_first_value(raw_plan, "hook", "opening", "golden_opening", "前3秒黄金开头", "黄金3秒开头", "黄金开头") or title)
        purpose = str(_first_value(raw_plan, "purpose", "suitable_for", "适合目的", "适合用途") or {
            "老板故事型": "让附近顾客认识老板和店铺故事",
            "产品展示型": "把产品特色和制作细节讲清楚",
            "本地流量型": "吸引附近顾客自然到店",
        }[PLAN_TYPES[index]])
        visual = _first_value(raw_plan, "visual", "recommended_visual", "推荐画面", "画面建议", "视频画面")
        materials_value = _first_value(raw_plan, "materials", "material_suggestions", "拍摄素材建议", "素材建议", "拍摄建议")
        if materials_value in (None, "") and visual not in (None, ""):
            materials_value = [visual]
        if materials_value in (None, ""):
            materials_value = ["店铺门头和环境", "产品或服务过程", "老板出镜分享"]
        if isinstance(materials_value, str):
            materials = [materials_value]
        elif isinstance(materials_value, list):
            materials = [str(material) for material in materials_value if str(material).strip()]
        else:
            materials = [str(materials_value)]
        if not materials:
            materials = ["店铺环境", "产品展示", "老板出镜"]
        visual = str(visual or "、".join(materials))

        script_value = _first_value(raw_plan, "script", "voiceover_script", "60秒口播脚本", "60秒脚本", "口播稿")
        script = str(script_value or f"我是这家店的老板，今天想和你聊聊{title}。附近的朋友有空可以来店里坐坐。")

        plan = {
            "type": _first_value(raw_plan, "type", "plan_type", "方案类型") or PLAN_TYPES[index],
            "theme": theme,
            "hook": hook,
            "title": title,
            "purpose": purpose,
            "visual": visual,
            "materials": materials,
            "script": script,
            "storyboard": _first_value(raw_plan, "storyboard", "video_storyboard", "视频分镜", "分镜建议") or [],
            "caption": _first_value(raw_plan, "caption", "publish_copy", "发布文案", "文案") or "",
            "hashtags": _first_value(raw_plan, "hashtags", "hot_tags", "热门标签", "话题标签") or [],
        }

        if isinstance(plan["storyboard"], str):
            plan["storyboard"] = [plan["storyboard"]]
        if not isinstance(plan["storyboard"], list):
            plan["storyboard"] = []
        if isinstance(plan["hashtags"], str):
            plan["hashtags"] = [tag.strip() for tag in plan["hashtags"].replace("，", ",").split(",") if tag.strip()]
        if not isinstance(plan["hashtags"], list):
            plan["hashtags"] = []
        plan["hashtags"] = [str(tag) for tag in plan["hashtags"]]
        plans.append(plan)

    return {
        "plans": plans,
        # Keep the previous top-level fields mapped to the first plan for compatibility.
        **{key: plans[0][key] for key in ("theme", "hook", "title", "script", "visual", "storyboard", "caption", "hashtags")},
    }


def generate_video_copy(
    *,
    shop_name: str,
    industry: str,
    city: str,
    specialty: str,
) -> dict[str, Any]:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise DeepSeekServiceError("未配置 AI 服务 API Key，请先在 backend/.env 中完成配置")

    system_prompt = _load_prompt()
    user_prompt = f"""
请根据以下店铺信息一次生成 3 套不同的短视频方案，并且只返回合法 JSON，不要使用 Markdown 代码块：

店铺名称：{shop_name}
行业：{industry}
城市：{city}
经营特色：{specialty}

JSON 字段必须是 plans，且必须严格包含 3 个方案，类型依次为老板故事型、产品展示型、本地流量型：
{{
  "plans": [
    {{
      "type": "老板故事型",
      "theme": "视频主题",
      "hook": "前3秒黄金开头",
      "title": "发布标题",
      "purpose": "适合目的",
      "materials": ["拍摄素材建议1", "拍摄素材建议2"],
      "script": "60秒口播稿",
      "storyboard": [{{"time": "0-3秒", "visual": "画面内容", "voiceover": "对应口播"}}],
      "caption": "发布文案",
      "hashtags": ["#本地生活", "#城市名", "#行业标签"]
    }},
    {{"type": "产品展示型", "theme": "...", "hook": "...", "title": "...", "purpose": "...", "materials": ["..."], "script": "...", "storyboard": [{{"time": "...", "visual": "...", "voiceover": "..."}}], "caption": "...", "hashtags": ["..."]}},
    {{"type": "本地流量型", "theme": "...", "hook": "...", "title": "...", "purpose": "...", "materials": ["..."], "script": "...", "storyboard": [{{"time": "...", "visual": "...", "voiceover": "..."}}], "caption": "...", "hashtags": ["..."]}}
  ]
}}
"""
    request_body = {
        "model": os.getenv("DEEPSEEK_MODEL", DEFAULT_MODEL),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.8,
        "max_tokens": 3600,
        "stream": False,
    }
    request = Request(
        DEEPSEEK_URL,
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=90) as response:
            response_body = response.read().decode("utf-8")
            print("========== AI RAW RESPONSE ==========", flush=True)
            print(response_body, flush=True)
            print("========== END RESPONSE ==========", flush=True)
            response_payload = json.loads(response_body)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:300]
        raise DeepSeekServiceError(f"AI 服务请求失败（HTTP {error.code}）：{detail}") from error
    except (URLError, TimeoutError) as error:
        raise DeepSeekServiceError("AI 服务网络请求失败，请检查网络后重试") from error
    except json.JSONDecodeError as error:
        LOGGER.error("AI 服务返回的原始响应不是 JSON：%s", response_body)
        raise DeepSeekServiceError("AI 服务返回的内容不是合法 JSON") from error

    content: Any = None
    try:
        content = response_payload["choices"][0]["message"]["content"]
        _log_raw_content(content)
        model_result = _parse_model_content(content)
    except (KeyError, IndexError, TypeError, DeepSeekServiceError) as error:
        raw_content = content if content is not None else response_payload
        LOGGER.error("AI 返回内容解析失败，真实返回内容：\n%s", raw_content)
        print(f"AI 返回内容解析失败，真实返回内容：\n{raw_content}", flush=True)
        raise DeepSeekServiceError("AI 服务返回内容格式不正确") from error

    try:
        return _normalize_result(model_result)
    except DeepSeekServiceError:
        LOGGER.error("AI 返回字段校验失败，真实返回内容：\n%s", content)
        print(f"AI 返回字段校验失败，真实返回内容：\n{content}", flush=True)
        raise
