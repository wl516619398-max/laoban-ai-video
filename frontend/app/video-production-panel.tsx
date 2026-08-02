"use client";

import { useEffect, useRef, useState } from "react";
import { getApiUrl } from "../lib/api";

type VideoPlan = {
  type?: string;
  theme?: string;
  hook?: string;
  title?: string;
  script?: string;
};

type TaskStatus =
  | "pending"
  | "generating_voice"
  | "voice_ready"
  | "generating_subtitles"
  | "mixing_materials"
  | "burning_subtitles"
  | "generating_cover"
  | "composing_final"
  | "success"
  | "completed"
  | "failed";

type TaskPayload = {
  task_id?: string;
  status?: TaskStatus;
  status_label?: string;
  voice_url?: string;
  video_url?: string;
  error?: string | null;
};

const productionSteps = [
  "准备生成视频",
  "正在生成配音",
  "正在生成字幕",
  "正在合成视频",
  "视频生成完成",
];

const stepByStatus: Partial<Record<TaskStatus, number>> = {
  pending: 0,
  generating_voice: 1,
  voice_ready: 2,
  generating_subtitles: 2,
  mixing_materials: 3,
  burning_subtitles: 3,
  generating_cover: 3,
  composing_final: 3,
  success: productionSteps.length,
  completed: productionSteps.length,
};

function userFacingError() {
  return "视频制作失败，请重新尝试。";
}

export default function VideoProductionPanel({
  plan,
  storeInfo,
  materialIds,
  materialNames,
  shopName,
  voice,
  userId,
  remainingCount,
  onGenerationSuccess,
}: {
  plan: VideoPlan;
  storeInfo: Record<string, string>;
  materialIds: string[];
  materialNames: string[];
  shopName: string;
  voice: string;
  userId: string;
  remainingCount: number | null;
  onGenerationSuccess: () => void;
}) {
  const [script, setScript] = useState(plan.script || "");
  const [status, setStatus] = useState<"idle" | "processing" | "success">("idle");
  const [activeStep, setActiveStep] = useState(0);
  const [taskId, setTaskId] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const renderRequested = useRef(false);

  useEffect(() => {
    setScript(plan.script || "");
    setStatus("idle");
    setActiveStep(0);
    setTaskId("");
    setVideoUrl("");
    setVoiceUrl("");
    setError("");
    renderRequested.current = false;
  }, [plan]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`${getApiUrl()}/video-tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as TaskPayload;
        if (!response.ok) throw new Error(userFacingError());
        if (cancelled) return;

        if (payload.status && payload.status in stepByStatus) {
          setActiveStep(stepByStatus[payload.status] ?? 0);
        }
        if (payload.voice_url) setVoiceUrl(`${getApiUrl()}${payload.voice_url}`);
        if (payload.video_url) setVideoUrl(`${getApiUrl()}${payload.video_url}`);

        if (payload.status === "failed") {
          setError(userFacingError());
          setStatus("idle");
          return;
        }
        if (payload.status === "success" || payload.status === "completed") {
          setActiveStep(productionSteps.length);
          setStatus("success");
          onGenerationSuccess();
          return;
        }

        if (payload.status === "voice_ready" && !renderRequested.current) {
          renderRequested.current = true;
          const renderResponse = await fetch(`${getApiUrl()}/video-tasks/${encodeURIComponent(taskId)}/render`, { method: "POST" });
          if (!renderResponse.ok) throw new Error(userFacingError());
        }
        timer = window.setTimeout(() => void poll(), 800);
      } catch (pollError) {
        if (!cancelled) {
          console.error("[video-task] polling failed", pollError);
          setError(userFacingError());
          setStatus("idle");
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [taskId, onGenerationSuccess]);

  const startProduction = async () => {
    if (!script.trim()) {
      setError("请先确认口播文案。");
      return;
    }
    if (!materialIds.length) {
      setError("请先上传视频素材。");
      return;
    }
    if (remainingCount === null) {
      setError("正在获取今日体验次数，请稍后再试。");
      return;
    }
    if (remainingCount === 0) {
      setError("今日体验次数已用完，明天可以继续制作。");
      return;
    }

    setError("");
    setStatus("processing");
    setActiveStep(0);
    setTaskId("");
    setVideoUrl("");
    setVoiceUrl("");
    renderRequested.current = false;

    try {
      const response = await fetch(`${getApiUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store_info: storeInfo,
          selected_plan: { ...plan, script: script.trim() },
          video_files: materialIds,
          voice,
          user_id: userId,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as TaskPayload;
      if (!response.ok || !payload.task_id) throw new Error(userFacingError());
      setTaskId(payload.task_id);
    } catch (startError) {
      console.error("[video-task] create failed", startError);
      setError(userFacingError());
      setStatus("idle");
    }
  };

  return (
    <section className="production-panel" aria-live="polite">
      <div className="production-panel-heading">
        <div>
          <span className="eyebrow">视频制作</span>
          <h3>确认文案，生成你的短视频</h3>
          <p>可以先修改口播内容，确认后会自动完成配音、字幕、混剪和封面。</p>
          <p className="production-waiting">本次使用 {materialNames.length} 个视频素材</p>
        </div>
        {status === "idle" && <button type="button" className="generate-button" onClick={() => void startProduction()} disabled={!userId || !materialIds.length || remainingCount === null || remainingCount === 0}>🎬 开始生成视频</button>}
        {status === "idle" && materialIds.length === 0 && <p className="production-waiting">上传素材完成后，可以开始生成视频。</p>}
      </div>

      {status === "idle" && <textarea className="production-script" value={script} onChange={(event) => setScript(event.target.value)} rows={10} aria-label="可编辑口播文案" />}
      {error && <p className="error-message" role="alert">{error}</p>}

      {status === "processing" && <div className="production-progress">
        <p className="production-progress-title">正在准备视频...</p>
        <div className="production-progress-bar"><span style={{ width: `${Math.min(100, (activeStep / productionSteps.length) * 100)}%` }} /></div>
        <ol>
          {productionSteps.map((step, index) => {
            const done = index < activeStep;
            const current = index === activeStep;
            return <li key={step} className={done ? "done" : current ? "current" : "pending"}><span>{done ? "✓" : index + 1}</span>{step}{current && <i>制作中</i>}</li>;
          })}
        </ol>
      </div>}

      {status === "success" && <div className="production-result">
        <div>
          <span className="eyebrow">视频生成完成</span>
          <h3>你的短视频已经做好了</h3>
          <p>{shopName} · {plan.title || plan.theme}</p>
        </div>
        {videoUrl ? <video ref={videoRef} controls playsInline preload="metadata" src={videoUrl} className="production-video" /> : <p className="status-message">视频正在准备，请稍后刷新。</p>}
        <div className="production-actions">
          {videoUrl && <button type="button" className="generate-button" onClick={() => void videoRef.current?.play()}>播放视频</button>}
          {videoUrl && <a className="generate-button" href={`${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1`} download={`${shopName || "店铺"}-短视频.mp4`}>下载视频</a>}
          {voiceUrl && <audio controls preload="metadata" src={voiceUrl} />}
          <button type="button" className="copy-button" onClick={() => { setStatus("idle"); setTaskId(""); setVideoUrl(""); setVoiceUrl(""); setError(""); }}>重新制作</button>
        </div>
      </div>}
    </section>
  );
}
