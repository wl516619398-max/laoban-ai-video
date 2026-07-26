from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from services.ai.deepseek_service import DeepSeekServiceError, generate_video_copy
from services.editor_service import (
    VideoRenderError,
    add_voice_to_video,
    burn_subtitles_to_video,
    create_cover_video,
    create_subtitle_file,
    prepend_cover_to_video,
    render_video_segments,
)
from services.voice.tts_service import (
    SUPPORTED_VOICES,
    VOICE_PREVIEW_TEXT,
    VOICE_DISPLAY_NAMES,
    VoiceGenerationError,
    generate_voice_mp3,
)


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
logger = logging.getLogger("boss_ai_video")
logger.setLevel(logging.INFO)


def _resolve_configured_path(value: str, default: Path) -> Path:
    configured = Path(value).expanduser()
    return configured if configured.is_absolute() else BASE_DIR / configured


STORAGE_DIR = _resolve_configured_path(os.getenv("STORAGE_DIR", "storage"), BASE_DIR / "storage")
UPLOADS_DIR = STORAGE_DIR / "uploads"
TASK_STORAGE_DIR = STORAGE_DIR / "tasks"
DATABASE_PATH = _resolve_configured_path(os.getenv("DATABASE_PATH", "app.db"), BASE_DIR / "app.db")
TASK_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="video-task")
VOICE_PREVIEW_DIR = STORAGE_DIR / "voice-previews"
APP_ENV = os.getenv("APP_ENV", "development").strip().lower()
DAILY_VIDEO_LIMIT = 999 if APP_ENV in {"development", "dev", "test", "testing"} else 1
SUCCESS_STATUSES = ("success", "completed")
BEIJING_TIMEZONE = timezone(timedelta(hours=8))
DEFAULT_USER_ID = "legacy-anonymous-user"


def ensure_runtime_directories() -> None:
    """Create and validate all directories needed by the API process."""
    for directory in (STORAGE_DIR, UPLOADS_DIR, TASK_STORAGE_DIR, VOICE_PREVIEW_DIR, DATABASE_PATH.parent):
        directory.mkdir(parents=True, exist_ok=True)
        if not directory.is_dir():
            raise RuntimeError(f"Configured runtime path is not a directory: {directory}")


ensure_runtime_directories()


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_database() -> None:
    connection = get_connection()
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS uploads (
                file_id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS video_tasks (
                task_id TEXT PRIMARY KEY,
                material_id TEXT NOT NULL,
                material_ids_json TEXT NOT NULL DEFAULT '[]',
                script TEXT NOT NULL,
                cover_title TEXT NOT NULL DEFAULT '',
                shop_name TEXT NOT NULL DEFAULT '',
                tts_voice TEXT NOT NULL DEFAULT '',
                user_id TEXT NOT NULL DEFAULT '',
                created_date TEXT NOT NULL DEFAULT '',
                downloaded INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                voice_path TEXT NOT NULL DEFAULT '',
                video_path TEXT NOT NULL DEFAULT '',
                segments_json TEXT NOT NULL DEFAULT '[]',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(video_tasks)").fetchall()}
        if "material_ids_json" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN material_ids_json TEXT NOT NULL DEFAULT '[]'")
        if "video_path" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN video_path TEXT NOT NULL DEFAULT ''")
        if "cover_title" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN cover_title TEXT NOT NULL DEFAULT ''")
        if "shop_name" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN shop_name TEXT NOT NULL DEFAULT ''")
        if "tts_voice" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN tts_voice TEXT NOT NULL DEFAULT ''")
        if "user_id" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
        if "created_date" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN created_date TEXT NOT NULL DEFAULT ''")
        if "downloaded" not in columns:
            connection.execute("ALTER TABLE video_tasks ADD COLUMN downloaded INTEGER NOT NULL DEFAULT 0")
        connection.commit()
    finally:
        connection.close()


class GenerateRequest(BaseModel):
    shop_name: str = Field(min_length=1, max_length=80)
    industry: str = Field(min_length=1, max_length=40)
    city: str = Field(min_length=1, max_length=40)
    specialty: str = Field(min_length=1, max_length=300)
    material_id: str = Field(min_length=1, max_length=64)
    user_id: str = Field(default=DEFAULT_USER_ID, min_length=1, max_length=64)


class VideoTaskRequest(BaseModel):
    material_id: str = Field(default="", max_length=64)
    material_ids: list[str] = Field(default_factory=list, max_length=20)
    script: str = Field(min_length=1, max_length=12000)
    title: str = Field(default="", max_length=200)
    shop_name: str = Field(default="未命名店铺", max_length=80)
    voice: str = Field(default="zh-CN-XiaoxiaoNeural", max_length=64)
    user_id: str = Field(default=DEFAULT_USER_ID, min_length=1, max_length=64)


class VoicePreviewRequest(BaseModel):
    voice: str = Field(min_length=1, max_length=64)


app = FastAPI(title="老板AI短视频助手 API", version="0.1.0")
configured_origins = os.getenv("FRONTEND_ORIGINS", "")
allowed_origins = [origin.strip().rstrip("/") for origin in configured_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    ensure_runtime_directories()
    init_database()
    TASK_EXECUTOR.submit(_precache_voice_previews)


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "老板AI短视频助手 API 正在运行", "version": "0.1.0"}


@app.get("/usage")
def get_usage(user_id: str = Query(default=DEFAULT_USER_ID, min_length=1, max_length=64)) -> dict[str, int | str]:
    connection = get_connection()
    try:
        return _usage_payload(connection, user_id)
    finally:
        connection.close()


def _voice_preview_path(voice: str) -> Path:
    if voice not in SUPPORTED_VOICES:
        raise HTTPException(status_code=422, detail="暂不支持这个声音，请重新选择")
    return VOICE_PREVIEW_DIR / f"{voice}.mp3"


def _precache_voice_previews() -> None:
    """Warm all preview files once in the background; button clicks only read cached files."""
    VOICE_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for voice in sorted(SUPPORTED_VOICES):
        preview_path = VOICE_PREVIEW_DIR / f"{voice}.mp3"
        if preview_path.is_file() and preview_path.stat().st_size > 0:
            continue
        try:
            generate_voice_mp3(VOICE_PREVIEW_TEXT, preview_path, voice=voice)
        except VoiceGenerationError as error:
            print(f"试听音频缓存失败（{voice}）：{error}", flush=True)


@app.get("/voice-preview/{voice}")
def get_voice_preview(voice: str) -> FileResponse:
    preview_path = _voice_preview_path(voice)
    if not preview_path.is_file():
        raise HTTPException(status_code=503, detail="试听音频正在准备，请稍后重试")
    return FileResponse(preview_path, media_type="audio/mpeg", filename="voice-preview.mp3")


@app.post("/voice-preview")
def create_voice_preview(request: VoicePreviewRequest) -> FileResponse:
    """Return a cached standalone preview without creating a video task."""
    return get_voice_preview(request.voice)


VIDEO_STATUS_LABELS = {
    "pending": "排队中",
    "generating_voice": "生成配音",
    "voice_ready": "配音完成",
    "generating_subtitles": "生成字幕",
    "mixing_materials": "混剪素材",
    "burning_subtitles": "生成视频",
    "generating_cover": "生成封面",
    "composing_final": "合成最终视频",
    "completed": "生成完成",
    "success": "生成完成",
    "failed": "生成失败",
}


def _beijing_date() -> str:
    return datetime.now(BEIJING_TIMEZONE).date().isoformat()


def _daily_video_count(connection: sqlite3.Connection, user_id: str) -> int:
    placeholders = ",".join("?" for _ in SUCCESS_STATUSES)
    return int(connection.execute(
        f"SELECT COUNT(*) FROM video_tasks WHERE user_id = ? AND created_date = ? AND status IN ({placeholders})",
        (user_id, _beijing_date(), *SUCCESS_STATUSES),
    ).fetchone()[0])


def _usage_payload(connection: sqlite3.Connection, user_id: str) -> dict[str, int | str]:
    used_count = _daily_video_count(connection, user_id)
    return {
        "user_id": user_id,
        "app_env": APP_ENV,
        "daily_limit": DAILY_VIDEO_LIMIT,
        "used_count": used_count,
        "remaining_count": max(0, DAILY_VIDEO_LIMIT - used_count),
    }


def _update_video_task(task_id: str, status: str, **fields: str) -> None:
    updated_at = datetime.now(timezone.utc).isoformat()
    assignments = ["status = ?", "updated_at = ?"]
    values: list[Any] = [status, updated_at]
    for field in ("voice_path", "video_path", "segments_json", "error", "downloaded"):
        if field in fields:
            assignments.append(f"{field} = ?")
            values.append(fields[field])
    values.append(task_id)
    connection = get_connection()
    try:
        connection.execute(f"UPDATE video_tasks SET {', '.join(assignments)} WHERE task_id = ?", values)
        connection.commit()
    finally:
        connection.close()


def _mark_video_downloaded(task_id: str) -> None:
    connection = get_connection()
    try:
        connection.execute("UPDATE video_tasks SET downloaded = 1, updated_at = ? WHERE task_id = ?", (datetime.now(timezone.utc).isoformat(), task_id))
        connection.commit()
    finally:
        connection.close()


def _video_task_payload(row: sqlite3.Row) -> dict[str, Any]:
    status = str(row["status"])
    payload: dict[str, Any] = {
        "task_id": row["task_id"],
        "status": status,
        "status_label": VIDEO_STATUS_LABELS.get(status, status),
        "shop_name": row["shop_name"] or "未命名店铺",
        "plan_title": row["cover_title"] or "未命名方案",
        "user_id": row["user_id"] or DEFAULT_USER_ID,
        "voice": row["tts_voice"] or "zh-CN-XiaoxiaoNeural",
        "voice_label": VOICE_DISPLAY_NAMES.get(row["tts_voice"], "默认声音"),
        "download_status": "已下载" if row["downloaded"] else "未下载",
        "created_at": row["created_at"],
        "segments": json.loads(row["segments_json"] or "[]"),
        "error": row["error"] or None,
    }
    if row["voice_path"]:
        payload["voice_url"] = f"/video-tasks/{row['task_id']}/voice"
    if row["video_path"]:
        payload["video_url"] = f"/video-tasks/{row['task_id']}/video-file"
    return payload


def _get_upload_records(material_ids: list[str]) -> list[sqlite3.Row]:
    placeholders = ",".join("?" for _ in material_ids)
    connection = get_connection()
    try:
        rows = connection.execute(
            f"SELECT file_id, original_name, stored_name FROM uploads WHERE file_id IN ({placeholders})",
            material_ids,
        ).fetchall()
    finally:
        connection.close()
    by_id = {row["file_id"]: row for row in rows}
    missing = [material_id for material_id in material_ids if material_id not in by_id]
    if missing:
        raise VideoRenderError("部分视频素材不存在，请重新上传")
    return [by_id[material_id] for material_id in material_ids]


def _resolve_upload_path(stored_name: str) -> Path:
    """Support new uploads/ storage while keeping older MVP uploads readable."""
    current_path = UPLOADS_DIR / stored_name
    if current_path.is_file():
        return current_path
    return STORAGE_DIR / stored_name


def _process_voice_task(task_id: str, material_ids: list[str], script: str, voice: str) -> None:
    try:
        _update_video_task(task_id, "generating_voice")
        task_dir = TASK_STORAGE_DIR / task_id
        voice_path = task_dir / "voice.mp3"
        generated_voice = generate_voice_mp3(script, voice_path, voice=voice)
        _update_video_task(task_id, "voice_ready", voice_path=str(generated_voice))
    except (VoiceGenerationError, ValueError, OSError) as error:
        logger.exception("generate_failed task_id=%s stage=voice", task_id)
        _update_video_task(task_id, "failed", error=str(error))
    except Exception:
        logger.exception("generate_failed task_id=%s stage=voice", task_id)
        _update_video_task(task_id, "failed", error="视频制作任务失败，请稍后重试")


def _process_render_task(task_id: str) -> None:
    try:
        connection = get_connection()
        try:
            task = connection.execute("SELECT * FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
        finally:
            connection.close()
        if task is None:
            return
        material_ids = json.loads(task["material_ids_json"] or "[]") or [task["material_id"]]
        records = _get_upload_records(material_ids)
        material_paths = [_resolve_upload_path(row["stored_name"]) for row in records]
        voice_path = Path(task["voice_path"])
        task_dir = TASK_STORAGE_DIR / task_id
        output_path = task_dir / "final.mp4"
        silent_path = task_dir / "video-silent.mp4"
        voiced_path = task_dir / "video-voice.mp4"
        subtitle_path = task_dir / "subtitles.ass"
        body_path = task_dir / "video-with-subtitles.mp4"
        cover_image_path = task_dir / "cover.jpg"
        cover_title_path = task_dir / "cover-title.ass"
        cover_video_path = task_dir / "cover.mp4"
        _update_video_task(task_id, "generating_subtitles")
        create_subtitle_file(task["script"], voice_path, subtitle_path)
        _update_video_task(task_id, "mixing_materials")
        edit_plan = render_video_segments(material_paths, material_ids, task["script"], voice_path, silent_path)
        segments = []
        names = {row["file_id"]: row["original_name"] for row in records}
        for segment in edit_plan["segments"]:
            segments.append({**segment, "material_name": names.get(segment["material_id"], segment["material_id"])})
        _update_video_task(task_id, "burning_subtitles", segments_json=json.dumps(segments, ensure_ascii=False))
        add_voice_to_video(silent_path, voice_path, voiced_path)
        burn_subtitles_to_video(voiced_path, subtitle_path, body_path)
        _update_video_task(task_id, "generating_cover")
        plan_title = task["cover_title"] or task["script"].split("。")[0].strip() or "今日店铺分享"
        cover_title = f"{task['shop_name'] or '未命名店铺'} · {plan_title}"
        create_cover_video(material_paths[0], cover_title, cover_image_path, cover_title_path, cover_video_path)
        _update_video_task(task_id, "composing_final")
        prepend_cover_to_video(cover_video_path, body_path, output_path)
        silent_path.unlink(missing_ok=True)
        voiced_path.unlink(missing_ok=True)
        body_path.unlink(missing_ok=True)
        cover_video_path.unlink(missing_ok=True)
        cover_image_path.unlink(missing_ok=True)
        cover_title_path.unlink(missing_ok=True)
        subtitle_path.unlink(missing_ok=True)
        time.sleep(0.4)
        _update_video_task(task_id, "success", video_path=str(output_path))
        logger.info("generate_success task_id=%s stage=render", task_id)
    except (VoiceGenerationError, VideoRenderError, ValueError, OSError) as error:
        logger.exception("generate_failed task_id=%s stage=render", task_id)
        _update_video_task(task_id, "failed", error=str(error))
    except Exception:
        logger.exception("generate_failed task_id=%s stage=render", task_id)
        _update_video_task(task_id, "failed", error="视频混剪失败，请稍后重试")


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> dict[str, str | bool]:
    filename = Path(file.filename or "").name
    suffix = Path(filename).suffix.lower()
    if suffix not in {".mp4", ".mov"}:
        await file.close()
        raise HTTPException(status_code=400, detail="仅支持 MP4 或 MOV 格式的视频素材")

    file_id = f"{uuid.uuid4().hex[:12]}{suffix}"
    created_at = datetime.now(timezone.utc).isoformat()
    stored_name = file_id
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    stored_path = UPLOADS_DIR / stored_name
    file_size = 0
    try:
        with stored_path.open("wb") as output_file:
            while chunk := await file.read(1024 * 1024):
                output_file.write(chunk)
                file_size += len(chunk)
    except OSError as error:
        stored_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="素材保存失败") from error
    finally:
        await file.close()

    connection = get_connection()
    try:
        connection.execute(
            "INSERT INTO uploads (file_id, original_name, stored_name, file_size, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                file_id,
                filename,
                stored_name,
                file_size,
                created_at,
            ),
        )
        connection.commit()
    finally:
        connection.close()

    return {
        "success": True,
        "file_id": file_id,
        "filename": filename,
    }


@app.post("/generate")
def generate_video_script(request: GenerateRequest) -> dict[str, Any]:
    logger.info("generate_start user_id=%s material_id=%s stage=copy", request.user_id, request.material_id)
    connection = get_connection()
    try:
        upload = connection.execute(
            "SELECT file_id FROM uploads WHERE file_id = ?", (request.material_id,)
        ).fetchone()
    finally:
        connection.close()
    if upload is None:
        logger.warning("generate_failed user_id=%s material_id=%s stage=upload", request.user_id, request.material_id)
        raise HTTPException(status_code=404, detail="素材不存在，请重新上传")

    try:
        result = generate_video_copy(
            shop_name=request.shop_name,
            industry=request.industry,
            city=request.city,
            specialty=request.specialty,
        )
        logger.info("generate_success user_id=%s material_id=%s stage=copy", request.user_id, request.material_id)
        return result
    except DeepSeekServiceError as error:
        logger.exception("generate_failed user_id=%s material_id=%s stage=copy", request.user_id, request.material_id)
        raise HTTPException(status_code=502, detail=str(error)) from error
    except Exception as error:
        logger.exception("generate_failed user_id=%s material_id=%s stage=copy", request.user_id, request.material_id)
        raise HTTPException(status_code=502, detail=str(error) or "AI 文案生成失败，请稍后重试") from error


@app.post("/video-tasks", status_code=202)
def create_video_task(request: VideoTaskRequest) -> dict[str, Any]:
    material_ids = list(dict.fromkeys(request.material_ids or ([request.material_id] if request.material_id else [])))
    if not material_ids:
        raise HTTPException(status_code=422, detail="至少需要一个视频素材")
    connection = get_connection()
    try:
        if _daily_video_count(connection, request.user_id) >= DAILY_VIDEO_LIMIT:
            raise HTTPException(status_code=429, detail="今天的免费生成次数已用完，明天可以继续生成。")
        placeholders = ",".join("?" for _ in material_ids)
        count = connection.execute(
            f"SELECT COUNT(*) FROM uploads WHERE file_id IN ({placeholders})", material_ids
        ).fetchone()[0]
        if count != len(material_ids):
            raise HTTPException(status_code=404, detail="部分素材不存在，请重新上传")

        task_id = uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        created_date = _beijing_date()
        connection.execute(
            "INSERT INTO video_tasks (task_id, material_id, material_ids_json, script, cover_title, shop_name, tts_voice, user_id, created_date, downloaded, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (task_id, material_ids[0], json.dumps(material_ids, ensure_ascii=False), request.script, request.title, request.shop_name.strip() or "未命名店铺", request.voice, request.user_id, created_date, 0, "pending", now, now),
        )
        connection.commit()
        row = connection.execute("SELECT * FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()

    logger.info("generate_start task_id=%s user_id=%s stage=video", task_id, request.user_id)
    try:
        TASK_EXECUTOR.submit(_process_voice_task, task_id, material_ids, request.script, request.voice)
    except Exception as error:
        logger.exception("generate_failed task_id=%s user_id=%s stage=submit", task_id, request.user_id)
        _update_video_task(task_id, "failed", error=str(error) or "视频制作任务提交失败，请稍后重试")
        raise HTTPException(status_code=500, detail="视频制作任务提交失败，请稍后重试") from error
    return _video_task_payload(row)


@app.get("/video-tasks")
def list_video_tasks(limit: int = 50, user_id: str = Query(default=DEFAULT_USER_ID, min_length=1, max_length=64)) -> dict[str, list[dict[str, Any]]]:
    limit = max(1, min(limit, 100))
    connection = get_connection()
    try:
        rows = connection.execute(
            "SELECT * FROM video_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, limit)
        ).fetchall()
    finally:
        connection.close()
    return {"items": [_video_task_payload(row) for row in rows]}


@app.post("/video-tasks/{task_id}/render", status_code=202)
def render_video_task(task_id: str) -> dict[str, str]:
    connection = get_connection()
    try:
        row = connection.execute("SELECT status FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()
    if row is None:
        raise HTTPException(status_code=404, detail="视频制作任务不存在")
    if row["status"] in {"success", "completed"}:
        return {"status": "生成完成"}
    if row["status"] != "voice_ready":
        raise HTTPException(status_code=409, detail="配音尚未完成，请稍后重试")
    _update_video_task(task_id, "generating_subtitles")
    TASK_EXECUTOR.submit(_process_render_task, task_id)
    return {"status": "混剪中"}


@app.get("/video-tasks/{task_id}")
def get_video_task(task_id: str) -> dict[str, Any]:
    connection = get_connection()
    try:
        row = connection.execute("SELECT * FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()
    if row is None:
        raise HTTPException(status_code=404, detail="视频制作任务不存在")
    return _video_task_payload(row)


@app.get("/video-tasks/{task_id}/voice")
def get_video_voice(task_id: str) -> FileResponse:
    connection = get_connection()
    try:
        row = connection.execute("SELECT voice_path FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()
    if row is None or not row["voice_path"]:
        raise HTTPException(status_code=404, detail="配音文件尚未生成")
    voice_path = Path(row["voice_path"])
    if not voice_path.is_file():
        raise HTTPException(status_code=404, detail="配音文件不存在")
    return FileResponse(voice_path, media_type="audio/mpeg", filename="voice.mp3")


@app.get("/video-tasks/{task_id}/video")
def get_video_url(task_id: str) -> dict[str, str]:
    connection = get_connection()
    try:
        row = connection.execute("SELECT video_path FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()
    if row is None:
        raise HTTPException(status_code=404, detail="视频制作任务不存在")
    if not row["video_path"] or not Path(row["video_path"]).is_file():
        raise HTTPException(status_code=404, detail="视频尚未生成完成")
    return {"status": "生成完成", "video_url": f"/video-tasks/{task_id}/video-file"}


@app.get("/video-tasks/{task_id}/video-file")
def get_video_file(task_id: str, download: int = Query(default=0, ge=0, le=1)) -> FileResponse:
    connection = get_connection()
    try:
        row = connection.execute("SELECT video_path FROM video_tasks WHERE task_id = ?", (task_id,)).fetchone()
    finally:
        connection.close()
    if row is None or not row["video_path"]:
        raise HTTPException(status_code=404, detail="视频尚未生成完成")
    video_path = Path(row["video_path"])
    if not video_path.is_file():
        raise HTTPException(status_code=404, detail="视频文件不存在")
    if download == 1:
        _mark_video_downloaded(task_id)
    return FileResponse(video_path, media_type="video/mp4", filename="final.mp4")
