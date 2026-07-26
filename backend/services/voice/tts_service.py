"""Low-cost Chinese text-to-speech service for the MVP."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path


class VoiceGenerationError(Exception):
    """Raised when the voice file cannot be generated."""


SUPPORTED_VOICES = {
    # 精选男声：保留明显不同的语气，避免把云厂商全部声音直接暴露给用户。
    "zh-CN-YunxiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunyeNeural",
    "zh-CN-YunhaoNeural",
    "zh-CN-YunfengNeural",
    # 精选女声。
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaomoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-XiaoxuanNeural",
    "zh-CN-XiaohanNeural",
    "zh-CN-XiaoruiNeural",
}
VOICE_PREVIEW_TEXT = "你好，我是智能视频助手。我可以帮助老板快速生成短视频内容。"
VOICE_DISPLAY_NAMES = {
    "zh-CN-YunxiNeural": "老板亲切声",
    "zh-CN-YunjianNeural": "沉稳专业声",
    "zh-CN-YunyangNeural": "活力年轻声",
    "zh-CN-YunyeNeural": "故事分享声",
    "zh-CN-YunhaoNeural": "真实口播声",
    "zh-CN-YunfengNeural": "清晰讲解声",
    "zh-CN-XiaoxiaoNeural": "温柔客服声",
    "zh-CN-XiaomoNeural": "知性介绍声",
    "zh-CN-XiaoyiNeural": "活泼营销声",
    "zh-CN-XiaoxuanNeural": "邻家亲切声",
    "zh-CN-XiaohanNeural": "甜美聊天声",
    "zh-CN-XiaoruiNeural": "亲切老板娘声",
}
STABLE_MALE_VOICE = "zh-CN-YunxiNeural"
STABLE_FEMALE_VOICE = "zh-CN-XiaoxiaoNeural"
MALE_VOICES = {
    "zh-CN-YunxiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-YunyeNeural",
    "zh-CN-YunhaoNeural",
    "zh-CN-YunfengNeural",
}
VOICE_FALLBACKS = {
    voice: (STABLE_MALE_VOICE if voice.startswith("zh-CN-Yun") else STABLE_FEMALE_VOICE)
    for voice in SUPPORTED_VOICES
    if voice not in MALE_VOICES and voice not in {STABLE_FEMALE_VOICE}
}
VOICE_FALLBACKS["zh-CN-XiaohanNeural"] = STABLE_FEMALE_VOICE


def generate_voice_mp3(script: str, output_path: Path, voice: str | None = None) -> Path:
    """Generate a Chinese MP3 with Edge TTS and return its path."""
    text = script.strip()
    if not text:
        raise VoiceGenerationError("口播脚本不能为空")

    try:
        import edge_tts
    except ImportError as error:
        raise VoiceGenerationError("未安装 edge-tts，请先执行 pip install -r requirements.txt") from error

    selected_voice = (voice or os.getenv("TTS_VOICE", "zh-CN-XiaoxiaoNeural")).strip()
    if selected_voice not in SUPPORTED_VOICES:
        raise VoiceGenerationError("暂不支持这个配音声音，请重新选择")

    voice_candidates = [selected_voice]
    fallback_voice = VOICE_FALLBACKS.get(selected_voice)
    if fallback_voice:
        voice_candidates.append(fallback_voice)

    async def synthesize(voice_name: str) -> None:
        communicator = edge_tts.Communicate(text, voice=voice_name, rate="-5%")
        await communicator.save(str(output_path))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for voice_name in voice_candidates:
        for attempt in range(2):
            try:
                asyncio.run(synthesize(voice_name))
                last_error = None
                break
            except Exception as error:
                last_error = error
                output_path.unlink(missing_ok=True)
                if attempt == 0:
                    time.sleep(0.5)
        if last_error is None:
            break
    if last_error is not None:
        raise VoiceGenerationError("AI 配音生成失败，请检查网络或 TTS 配置") from last_error

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise VoiceGenerationError("AI 配音未生成有效的 voice.mp3")
    return output_path
