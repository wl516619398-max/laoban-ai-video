"""Simple FFmpeg-based video editing for the V0.7 MVP.

This module intentionally does not inspect video content. Sentence boundaries
come from Chinese full stops and materials are selected by the existing
round-robin/random mapping rules.
"""

from __future__ import annotations

import random
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Sequence


class VideoRenderError(Exception):
    """Raised when FFmpeg cannot render the requested video."""


def split_script_sentences(script: str) -> list[str]:
    """Split copy only at the Chinese full stop, keeping commas in place."""
    sentences = []
    for part in script.split("。"):
        sentence = part.strip()
        if sentence:
            sentences.append(f"{sentence}。")
    return sentences


SUBTITLE_PUNCTUATION = set("。！？；，,")


def _subtitle_char_count(text: str) -> int:
    chinese_count = len(re.findall(r"[\u3400-\u9fff]", text))
    return chinese_count or len(re.sub(r"\s+", "", text))


def _cut_text_by_count(text: str, count: int) -> int:
    current = 0
    for index, character in enumerate(text):
        if re.match(r"[\u3400-\u9fff]", character):
            current += 1
        elif not character.isspace():
            current += 1
        if current >= count:
            return index + 1
    return len(text)


def _split_long_subtitle_unit(unit: str, max_count: int = 18, target_count: int = 14) -> list[str]:
    if _subtitle_char_count(unit) <= max_count:
        return [unit]

    pieces: list[str] = []
    remaining = unit
    while _subtitle_char_count(remaining) > max_count:
        total = _subtitle_char_count(remaining)
        take = target_count
        if total - take < 6:
            take = max(6, total // 2)
        cut = _cut_text_by_count(remaining, take)
        pieces.append(remaining[:cut])
        remaining = remaining[cut:]

    if remaining:
        if _subtitle_char_count(remaining) < 6 and pieces:
            combined = pieces.pop() + remaining
            left_count = max(6, (_subtitle_char_count(combined) + 1) // 2)
            cut = _cut_text_by_count(combined, left_count)
            pieces.extend([combined[:cut], combined[cut:]])
        else:
            pieces.append(remaining)
    return [piece for piece in pieces if piece]


def split_subtitle_sentences(script: str) -> list[str]:
    """Split captions by Chinese punctuation and keep each line phone-friendly."""
    text = script.strip()
    if not text:
        return []

    units: list[str] = []
    buffer = ""
    for character in text:
        buffer += character
        if character in SUBTITLE_PUNCTUATION:
            units.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        units.append(buffer.strip())

    merged: list[str] = []
    index = 0
    while index < len(units):
        unit = units[index]
        while _subtitle_char_count(unit) < 6 and index + 1 < len(units):
            index += 1
            unit += units[index]
        merged.extend(_split_long_subtitle_unit(unit))
        index += 1
    return merged


def map_materials_to_sentences(sentences: list[str], material_ids: list[str]) -> list[str]:
    """Return one material id per sentence, looping or randomly sampling."""
    if not sentences:
        return []
    if not material_ids:
        raise ValueError("至少需要一个视频素材")
    if len(material_ids) <= len(sentences):
        return [material_ids[index % len(material_ids)] for index in range(len(sentences))]

    candidates = list(material_ids)
    random.shuffle(candidates)
    return candidates[: len(sentences)]


def create_video_edit(material_id: str, script: dict[str, Any]) -> dict[str, Any]:
    """Build the sentence-to-material plan used by the renderer."""
    voiceover = str(script.get("script") or script.get("voiceover") or "").strip()
    sentences = split_script_sentences(voiceover)
    material_ids = [str(item) for item in script.get("material_ids", []) if str(item).strip()]
    if not material_ids:
        material_ids = [material_id]

    mapped_materials = map_materials_to_sentences(sentences, material_ids)
    segments = [
        {
            "segment_index": index + 1,
            "sentence": sentence,
            "voiceover": sentence,
            "material_id": mapped_materials[index],
        }
        for index, sentence in enumerate(sentences)
    ]
    return {
        "sentence_count": len(sentences),
        "material_count": len(material_ids),
        "segment_count": len(segments),
        "segments": segments,
    }


def _ffmpeg_binary() -> str:
    configured = shutil.which("ffmpeg")
    if configured:
        return configured
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as error:
        raise VideoRenderError("未找到 FFmpeg，请先安装 imageio-ffmpeg 或系统 FFmpeg") from error


def _run_ffmpeg(arguments: list[str]) -> None:
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VideoRenderError("FFmpeg 执行失败或超时") from error
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "未知错误"
        raise VideoRenderError(f"FFmpeg 合成失败：{detail[:240]}")


def _probe_duration(ffmpeg: str, media_path: Path) -> float:
    try:
        result = subprocess.run([ffmpeg, "-i", str(media_path)], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise VideoRenderError("无法读取媒体时长") from error
    match = re.search(r"Duration: (\d+):(\d+):(\d+)(?:\.(\d+))?", result.stderr)
    if not match:
        raise VideoRenderError("无法读取 voice.mp3 时长")
    hours, minutes, seconds, fraction = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int((fraction or "0")[:3].ljust(3, "0")) / 1000


def _ass_timestamp(seconds: float) -> str:
    total_centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(total_centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, centiseconds = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def _escape_ass_text(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _wrap_ass_text(text: str, max_chars_per_line: int = 9) -> str:
    chunks: list[str] = []
    remaining = text
    while _subtitle_char_count(remaining) > max_chars_per_line:
        cut = _cut_text_by_count(remaining, max_chars_per_line)
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        chunks.append(remaining)
    return r"\N".join(_escape_ass_text(chunk) for chunk in chunks)


def _subtitle_filter_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")


def create_subtitle_file(script: str, voice_path: Path, output_path: Path) -> Path:
    """Create phone-friendly ASS subtitles timed against the generated voice."""
    sentences = split_subtitle_sentences(script)
    if not sentences:
        raise VideoRenderError("口播脚本没有可生成的字幕句子")
    ffmpeg = _ffmpeg_binary()
    total_duration = _probe_duration(ffmpeg, voice_path)
    if total_duration <= 0:
        raise VideoRenderError("无法读取配音时长")

    total_weight = sum(max(_subtitle_char_count(sentence), 1) for sentence in sentences)
    durations = [total_duration * max(_subtitle_char_count(sentence), 1) / total_weight for sentence in sentences]
    dialogue_lines = []
    elapsed = 0.0
    for index, sentence in enumerate(sentences):
        start = elapsed
        end = total_duration if index == len(sentences) - 1 else elapsed + durations[index]
        elapsed = end
        dialogue_lines.append(
            f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},Default,,0,0,0,,{_wrap_ass_text(sentence)}"
        )

    ass_content = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            "PlayResX: 720",
            "PlayResY: 1280",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            "Style: Default,Microsoft YaHei,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,0,2,70,70,110,134",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            *dialogue_lines,
            "",
        ]
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(ass_content, encoding="utf-8-sig")
    return output_path


def burn_subtitles_to_video(video_path: Path, subtitle_path: Path, output_path: Path) -> None:
    """Burn the generated ASS subtitles into a video while keeping its audio."""
    ffmpeg = _ffmpeg_binary()
    if not subtitle_path.is_file():
        raise VideoRenderError("字幕文件不存在")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    escaped_subtitle_path = _subtitle_filter_path(subtitle_path)
    subtitle_filter = f"subtitles=filename='{escaped_subtitle_path}'"
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-i",
            str(video_path),
            "-vf",
            subtitle_filter,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            str(output_path),
        ]
    )


def create_cover_image(material_path: Path, output_path: Path) -> Path:
    """Extract and crop a representative material frame to the 9:16 cover size."""
    if not material_path.is_file():
        raise VideoRenderError("封面素材文件不存在")
    ffmpeg = _ffmpeg_binary()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-ss",
            "0",
            "-i",
            str(material_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,eq=brightness=-0.12:saturation=1.08",
            "-q:v",
            "2",
            str(output_path),
        ]
    )
    return output_path


def create_cover_title_file(title: str, output_path: Path, duration: float = 0.8) -> Path:
    """Create a large, high-contrast ASS title for the cover segment."""
    clean_title = " ".join(str(title or "今日店铺分享").split())[:40]
    chunks = [clean_title[index : index + 10] for index in range(0, len(clean_title), 10)] or ["今日店铺分享"]
    cover_text = r"\N".join(_escape_ass_text(chunk) for chunk in chunks)
    ass_content = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            "PlayResX: 720",
            "PlayResY: 1280",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            "Style: Cover,Microsoft YaHei,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,0,5,40,40,0,134",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            f"Dialogue: 0,0:00:00.00,{_ass_timestamp(duration)},Cover,,0,0,0,,{cover_text}",
            "",
        ]
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(ass_content, encoding="utf-8-sig")
    return output_path


def create_cover_video(
    material_path: Path,
    title: str,
    image_path: Path,
    title_path: Path,
    output_path: Path,
    duration: float = 0.8,
) -> Path:
    """Create a short 9:16 cover clip with silent audio for final concatenation."""
    create_cover_image(material_path, image_path)
    create_cover_title_file(title, title_path, duration)
    ffmpeg = _ffmpeg_binary()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subtitle_filter = f"subtitles=filename='{_subtitle_filter_path(title_path)}'"
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-loop",
            "1",
            "-i",
            str(image_path),
            "-f",
            "lavfi",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t",
            f"{duration:.3f}",
            "-vf",
            subtitle_filter,
            "-r",
            "30",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-shortest",
            str(output_path),
        ]
    )
    return output_path


def prepend_cover_to_video(cover_path: Path, body_path: Path, output_path: Path) -> None:
    """Prepend the cover clip while normalizing audio for reliable concatenation."""
    ffmpeg = _ffmpeg_binary()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    filter_graph = (
        "[0:v]fps=30,format=yuv420p[v0];"
        "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0];"
        "[1:v]fps=30,format=yuv420p[v1];"
        "[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1];"
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
    )
    _run_ffmpeg(
        [
            ffmpeg,
            "-y",
            "-i",
            str(cover_path),
            "-i",
            str(body_path),
            "-filter_complex",
            filter_graph,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "44100",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )


def _concat_line(path: Path) -> str:
    return f"file '{str(path).replace("'", "'\\''")}'"


def render_video_segments(
    material_paths: Sequence[Path],
    material_ids: Sequence[str],
    script: str,
    voice_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    """Create a silent video with one clip per script sentence.

    Clip durations are proportional to each sentence's character length and
    the actual voice.mp3 duration, rather than fixed time slicing.
    """
    if not material_paths or len(material_paths) != len(material_ids):
        raise VideoRenderError("视频素材与素材 ID 数量不一致")
    if any(not path.is_file() for path in material_paths):
        raise VideoRenderError("上传的视频素材文件不存在")
    sentences = split_script_sentences(script)
    if not sentences:
        raise VideoRenderError("口播脚本没有可制作的完整句子")

    ffmpeg = _ffmpeg_binary()
    edit_plan = create_video_edit(str(material_ids[0]), {"script": script, "material_ids": list(material_ids)})
    selected_ids = [segment["material_id"] for segment in edit_plan["segments"]]
    path_by_id = dict(zip(material_ids, material_paths))
    total_voice_duration = _probe_duration(ffmpeg, voice_path)
    total_weight = sum(max(len(sentence.rstrip("。")), 1) for sentence in sentences)
    durations = [max(total_voice_duration * max(len(sentence.rstrip("。")), 1) / total_weight, 0.2) for sentence in sentences]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="clips-", dir=output_path.parent) as temp_dir:
        temp_path = Path(temp_dir)
        clip_paths: list[Path] = []
        for index, (material_id, duration) in enumerate(zip(selected_ids, durations)):
            source_path = path_by_id.get(material_id)
            if source_path is None:
                raise VideoRenderError("素材映射失败")
            clip_path = temp_path / f"clip-{index:03d}.mp4"
            _run_ffmpeg([
                ffmpeg, "-y", "-stream_loop", "-1", "-i", str(source_path), "-t", f"{duration:.3f}",
                "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
                "-an", "-c:v", "libx264", "-preset", "ultrafast", "-r", "30", str(clip_path),
            ])
            clip_paths.append(clip_path)

        concat_path = temp_path / "concat.txt"
        concat_path.write_text("\n".join(_concat_line(path) for path in clip_paths), encoding="utf-8")
        _run_ffmpeg([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path), "-an", "-c", "copy", str(output_path)])

    return edit_plan


def add_voice_to_video(video_path: Path, voice_path: Path, output_path: Path) -> None:
    """Mux the generated voice track into the silent rendered video."""
    ffmpeg = _ffmpeg_binary()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg([
        ffmpeg, "-y", "-i", str(video_path), "-i", str(voice_path),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", str(output_path),
    ])


def render_video(
    material_paths: Sequence[Path],
    material_ids: Sequence[str],
    script: str,
    voice_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    """Render the MVP final.mp4 from materials, script and voice.mp3."""
    silent_path = output_path.with_name("video-silent.mp4")
    edit_plan = render_video_segments(material_paths, material_ids, script, voice_path, silent_path)
    try:
        add_voice_to_video(silent_path, voice_path, output_path)
    finally:
        silent_path.unlink(missing_ok=True)
    return edit_plan
