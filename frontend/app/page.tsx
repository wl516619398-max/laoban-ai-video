"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const UPLOAD_TIMEOUT_MS = 120000;
const GENERATE_TIMEOUT_MS = 90000;
const USER_ID_STORAGE_KEY = "boss-ai-anonymous-user-id";

function getOrCreateAnonymousUserId() {
  const existing = window.localStorage.getItem(USER_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(USER_ID_STORAGE_KEY, generated);
  return generated;
}

function apiErrorMessage(payload: unknown, fallback: string) {
  const detail = typeof payload === "object" && payload !== null && "detail" in payload ? String(payload.detail) : fallback;
  if (/ffmpeg|tts|deepseek|traceback|exception|sqlite|task[_-]?id|video-tasks|internal server error|\bapi\b|status code/i.test(detail)) return fallback;
  return detail;
}

function friendlyErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return /ffmpeg|tts|deepseek|traceback|exception|sqlite|task[_-]?id|video-tasks|internal server error|\bapi\b|status code/i.test(message) ? fallback : message;
}

function videoGenerationErrorMessage() {
  return "视频生成遇到一点问题，请稍后重试。";
}

type StoryboardShot = { time?: string; visual?: string; voiceover?: string };
type VideoPlan = {
  type: string;
  theme: string;
  hook: string;
  title: string;
  purpose: string;
  materials: string[];
  script: string;
  storyboard: Array<StoryboardShot | string>;
  caption: string;
  hashtags: string[];
};
type GenerateResult = { plans: VideoPlan[] };
type UsageResult = { remaining_count: number; daily_limit: number; used_count: number };
type VideoSegment = { sentence: string; materialName: string };
type VideoTaskStatus = "generating_voice" | "voice_ready" | "generating_subtitles" | "mixing_materials" | "burning_subtitles" | "generating_cover" | "composing_final" | "completed" | "failed";
type VideoTaskResult = { task_id: string; status: VideoTaskStatus; status_label: string; shop_name?: string; plan_title?: string; created_at?: string; voice_url?: string; video_url?: string; segments?: Array<{ sentence: string; material_id?: string; material_name?: string }>; error?: string | null };

const steps = [
  { number: "01", title: "拍摄店铺素材", text: "用手机随手拍店里真实的日常" },
  { number: "02", title: "AI生成短视频内容", text: "自动生成文案、配音、字幕和视频" },
  { number: "03", title: "下载视频发布抖音", text: "做好后直接下载，发给附近顾客看" },
];

const industryCases = [
  { industry: "餐饮店", emoji: "🍢", color: "from-[#ffe7c2] to-[#fff8ec]", source: "老板手机随手拍：后厨、出餐、门口排队", title: "开了10年的烧烤店，为什么晚上还有这么多人排队？" },
  { industry: "理发店", emoji: "✂️", color: "from-[#dceeff] to-[#f3f9ff]", source: "老板手机随手拍：剪发过程、店内环境、顾客变化", title: "县城理发店不办卡，也能让老顾客一直回来" },
  { industry: "美容店", emoji: "💆", color: "from-[#f7ddf2] to-[#fff6fc]", source: "老板手机随手拍：服务过程、产品细节、顾客反馈", title: "做了8年美容，我最想提醒顾客注意这件事" },
  { industry: "零售店", emoji: "🛍️", color: "from-[#dff4e4] to-[#f5fff7]", source: "老板手机随手拍：进货、陈列、顾客挑选", title: "每天都有人来买的小店，老板只做对了这三件事" },
];

const planColors = [
  { bg: "bg-[#fff8ec]", border: "border-[#f4d3a8]", text: "text-[#9a5b20]", badge: "bg-[#f9e3bf]" },
  { bg: "bg-[#f0f8ff]", border: "border-[#c4ddf1]", text: "text-[#32658c]", badge: "bg-[#dbeeff]" },
  { bg: "bg-[#f0fbf3]", border: "border-[#c7e5ce]", text: "text-[#26704a]", badge: "bg-[#dff4e4]" },
];

type VoiceOption = { id: string; label: string; group: "男声" | "女声"; hint: string };
type UploadItemStatus = "等待上传" | "上传中" | "上传完成" | "上传失败";
type UploadItem = { id: string; fileName: string; progress: number; status: UploadItemStatus };
const voiceOptions: VoiceOption[] = [
  { id: "zh-CN-YunjianNeural", label: "稳重大叔", group: "男声", hint: "适合讲店铺故事、介绍经营年头" },
  { id: "zh-CN-YunxiNeural", label: "年轻老板", group: "男声", hint: "适合日常分享、老板出镜" },
  { id: "zh-CN-YunyangNeural", label: "热情销售", group: "男声", hint: "适合产品展示、优惠活动" },
  { id: "zh-CN-YunyeNeural", label: "新闻播报", group: "男声", hint: "适合活动通知、重点信息" },
  { id: "zh-CN-YunhaoNeural", label: "真实口播", group: "男声", hint: "适合门店日常、自然聊天" },
  { id: "zh-CN-YunfengNeural", label: "专业介绍", group: "男声", hint: "适合产品特点、服务说明" },
  { id: "zh-CN-YunyiNeural", label: "磁性男声", group: "男声", hint: "适合品牌故事、重点开场" },
  { id: "zh-CN-YunxiaNeural", label: "活力男声", group: "男声", hint: "适合热闹门店、活动宣传" },
  { id: "zh-CN-YunfanNeural", label: "温和男声", group: "男声", hint: "适合服务介绍、顾客沟通" },
  { id: "zh-CN-YunzheNeural", label: "讲故事男声", group: "男声", hint: "适合老板经历、本地故事" },
  { id: "zh-CN-XiaoxiaoNeural", label: "温柔客服", group: "女声", hint: "适合服务介绍、温和沟通" },
  { id: "zh-CN-XiaoyiNeural", label: "活力女生", group: "女声", hint: "适合产品展示、优惠活动" },
  { id: "zh-CN-XiaohanNeural", label: "甜美女声", group: "女声", hint: "适合轻松分享、生活场景" },
  { id: "zh-CN-XiaomoNeural", label: "专业介绍", group: "女声", hint: "适合产品特点、服务说明" },
  { id: "zh-CN-XiaoxuanNeural", label: "邻家姐姐", group: "女声", hint: "适合本地生活、自然聊天" },
  { id: "zh-CN-XiaoruiNeural", label: "亲切老板娘", group: "女声", hint: "适合店铺日常、老板娘出镜" },
  { id: "zh-CN-XiaoshuangNeural", label: "新闻播报", group: "女声", hint: "适合活动通知、重点信息" },
  { id: "zh-CN-XiaoyouNeural", label: "知性女生", group: "女声", hint: "适合品牌介绍、细节讲解" },
  { id: "zh-CN-XiaozhenNeural", label: "热情销售", group: "女声", hint: "适合产品推荐、到店引导" },
  { id: "zh-CN-XiaomengNeural", label: "轻松聊天", group: "女声", hint: "适合顾客故事、朋友式分享" },
];

function uploadFileWithProgress(file: File, onProgress: (progress: number) => void) {
  return new Promise<{ file_id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const data = new FormData();
    data.append("file", file);
    xhr.open("POST", `${API_URL}/upload`);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let payload: { file_id?: string } = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        reject(new Error("素材上传失败，请稍后重试。"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300 || !payload.file_id) {
        reject(new Error("素材上传失败，请稍后重试。"));
        return;
      }
      onProgress(100);
      resolve({ file_id: payload.file_id });
    };
    xhr.onerror = () => reject(new Error("素材上传失败，请稍后重试。"));
    xhr.ontimeout = () => reject(new Error("上传超时，请稍后重试。"));
    xhr.onabort = () => reject(new Error("上传已取消，请稍后重试。"));
    xhr.send(data);
  });
}

const videoSteps = [
  "AI正在分析你的店铺...",
  "正在生成爆款文案...",
  "正在生成配音...",
  "正在生成字幕...",
  "正在制作视频...",
  "视频生成完成",
];

const taskStepByStatus: Record<VideoTaskStatus, number> = {
  generating_voice: 2,
  voice_ready: 3,
  generating_subtitles: 3,
  mixing_materials: 4,
  burning_subtitles: 4,
  generating_cover: 5,
  composing_final: 5,
  completed: videoSteps.length,
  failed: 1,
};

function splitScriptSentences(script: string) {
  return script.split("。").map((part) => part.trim()).filter(Boolean).map((sentence) => `${sentence}。`);
}

function mapMaterialsToSentences(sentences: string[], materials: string[]): VideoSegment[] {
  if (!sentences.length) return [];
  const availableMaterials = materials.length ? materials : ["当前上传素材"];
  let selectedMaterials = availableMaterials;
  if (availableMaterials.length > sentences.length) {
    selectedMaterials = [...availableMaterials];
    for (let index = selectedMaterials.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [selectedMaterials[index], selectedMaterials[randomIndex]] = [selectedMaterials[randomIndex], selectedMaterials[index]];
    }
    selectedMaterials = selectedMaterials.slice(0, sentences.length);
  }
  return sentences.map((sentence, index) => ({ sentence, materialName: selectedMaterials[index % selectedMaterials.length] }));
}

function PlanCards({ result, sourceFiles, materialIds, shopName, voice, userId, remainingCount, onRegenerateCopy, onGenerationCreated }: { result: GenerateResult; sourceFiles: File[]; materialIds: string[]; shopName: string; voice: string; userId: string; remainingCount: number | null; onRegenerateCopy: () => Promise<void>; onGenerationCreated: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [productionStatus, setProductionStatus] = useState<"idle" | "processing" | "completed">("idle");
  const [activeStep, setActiveStep] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [taskId, setTaskId] = useState("");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [taskError, setTaskError] = useState("");
  const [scriptDraft, setScriptDraft] = useState("");
  const [regeneratingCopy, setRegeneratingCopy] = useState(false);
  const plans = result.plans.slice(0, 3);
  const selectedPlan = plans[selectedIndex];
  const previewFile = sourceFiles[0];

  useEffect(() => {
    if (!previewFile) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(previewFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFile]);

  useEffect(() => {
    setScriptDraft(selectedPlan?.script || "");
    setProductionStatus("idle");
    setTaskId("");
    setVoiceUrl("");
    setVideoUrl("");
  }, [selectedPlan]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const pollTask = async () => {
      try {
        const response = await fetch(`${API_URL}/video-tasks/${taskId}`);
        const payload = (await response.json().catch(() => ({}))) as Partial<VideoTaskResult> & { detail?: string };
        if (!response.ok) throw new Error(videoGenerationErrorMessage());
        if (cancelled) return;
        const status = payload.status;
        if (status) setActiveStep(taskStepByStatus[status]);
        if (payload.voice_url) setVoiceUrl(`${API_URL}${payload.voice_url}`);
        if (payload.video_url) setVideoUrl(`${API_URL}${payload.video_url}`);
        if (status === "completed") {
          setProductionStatus("completed");
          return;
        }
        if (status === "voice_ready") {
          const renderResponse = await fetch(`${API_URL}/video-tasks/${taskId}/render`, { method: "POST" });
          const renderPayload = (await renderResponse.json().catch(() => ({}))) as { detail?: string };
          if (!renderResponse.ok) throw new Error(videoGenerationErrorMessage());
        }
        if (status === "failed") {
          setTaskError(videoGenerationErrorMessage());
          setProductionStatus("idle");
          return;
        }
        window.setTimeout(pollTask, 700);
      } catch {
        if (!cancelled) {
          setTaskError(videoGenerationErrorMessage());
          setProductionStatus("idle");
        }
      }
    };
    void pollTask();
    return () => { cancelled = true; };
  }, [taskId]);

  const startVideoGeneration = async () => {
    if (!selectedPlan || !scriptDraft.trim()) {
      setTaskError("请先填写口播文案，再确认生成视频。");
      return;
    }
    if (!userId) {
      setTaskError("正在准备店铺信息，请稍后再试。");
      return;
    }
    setTaskError("");
    setVoiceUrl("");
    setVideoUrl("");
    setTaskId("");
    setActiveStep(0);
    setProductionStatus("processing");
    try {
      const response = await fetch(`${API_URL}/video-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ material_ids: materialIds, script: scriptDraft.trim(), title: selectedPlan.title, shop_name: shopName, voice, user_id: userId }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<VideoTaskResult> & { detail?: string };
      if (response.status === 429) throw new Error("今天的免费生成次数已用完，明天可以继续生成。");
      if (!response.ok || !payload.task_id) throw new Error(videoGenerationErrorMessage());
      setTaskId(payload.task_id);
      onGenerationCreated();
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : videoGenerationErrorMessage());
      setProductionStatus("idle");
    }
  };

  const regenerateCopy = async () => {
    setRegeneratingCopy(true);
    try {
      await onRegenerateCopy();
    } finally {
      setRegeneratingCopy(false);
    }
  };

  const copyFullScript = async () => {
    if (!selectedPlan) return;
    const materials = selectedPlan.materials.map((material, index) => `${index + 1}.${material}`).join("\n");
    const content = [
      "【视频主题】",
      selectedPlan.theme,
      "",
      "【推荐标题】",
      selectedPlan.title,
      "",
      "【黄金3秒开头】",
      selectedPlan.hook,
      "",
      "【60秒口播脚本】",
      scriptDraft,
      "",
      "【拍摄素材建议】",
      materials,
      "",
      "【发布文案】",
      selectedPlan.caption,
      "",
      "【热门标签】",
      selectedPlan.hashtags.join(" "),
    ].join("\n");

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-8 lg:px-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0e7548]">Three directions / 三套方向</p>
          <h2 className="mt-3 text-2xl font-bold text-[#173a2b] sm:text-3xl">选一套，今天就能开拍</h2>
        </div>
        <p className="text-sm text-[#71877a]">已选择：{plans[selectedIndex]?.type || "老板故事型"}</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        {plans.map((plan, index) => {
          const color = planColors[index] || planColors[0];
          const selected = selectedIndex === index;
          return (
            <article key={`${plan.type}-${index}`} className={`flex flex-col rounded-[1.75rem] border p-5 transition sm:p-6 ${selected ? `${color.border} ${color.bg} shadow-soft` : "border-[#d9e9df] bg-white"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${color.badge} ${color.text}`}>{String.fromCharCode(65 + index)} · {plan.type}</span>
                  <h3 className="mt-4 text-xl font-bold leading-8 text-[#173a2b]">{plan.theme}</h3>
                </div>
                {selected && <span className="text-xs font-bold text-[#0e7548]">已选择</span>}
              </div>
              <div className="mt-5 space-y-4 text-sm leading-7 text-[#426151]">
                <div><p className="text-xs font-bold text-[#769282]">推荐标题</p><p className="mt-1 font-semibold text-[#173a2b]">{plan.title}</p></div>
                <div><p className="text-xs font-bold text-[#769282]">适合目的</p><p className="mt-1">{plan.purpose}</p></div>
                <div><p className="text-xs font-bold text-[#769282]">拍摄素材建议</p><ul className="mt-1 list-disc space-y-1 pl-5">{plan.materials.map((material, materialIndex) => <li key={materialIndex}>{material}</li>)}</ul></div>
                <div><p className="text-xs font-bold text-[#769282]">前3秒黄金开头</p><p className="mt-1">{plan.hook}</p></div>
                <div><p className="text-xs font-bold text-[#769282]">60秒脚本</p><p className="mt-1 whitespace-pre-line">{plan.script}</p></div>
              </div>
              <button type="button" onClick={() => { setSelectedIndex(index); setCopied(false); setActiveStep(0); setTaskId(""); setVoiceUrl(""); setVideoUrl(""); setTaskError(""); setProductionStatus("idle"); }} className={`mt-6 w-full rounded-xl px-4 py-3 text-sm font-bold transition ${selected ? "bg-[#0e7548] text-white" : "bg-[#e8f4eb] text-[#0e7548] hover:bg-[#d9efdf]"}`}>{selected ? "已选择这套方案" : "选择这套方案"}</button>
            </article>
          );
        })}
      </div>
      {selectedPlan && <section className="mt-10 rounded-[2rem] border-2 border-[#7cc891] bg-[#f0fbf3] p-6 shadow-soft sm:p-10">
        <div className="flex flex-wrap items-start justify-between gap-5 border-b border-[#cfe9d6] pb-7">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0e7548]">Final production plan / 最终制作方案</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-[#173a2b] sm:text-3xl">🎬 你的专属短视频方案</h2>
            <p className="mt-2 text-sm text-[#607d6b]">已选择：{selectedPlan.type} · 现在就可以按这份方案开拍</p>
          </div>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void regenerateCopy()} disabled={regeneratingCopy} className="rounded-xl border border-[#0e7548] bg-white px-4 py-3 text-sm font-bold text-[#0e7548] transition hover:bg-[#e8f4eb] disabled:cursor-wait disabled:opacity-60">{regeneratingCopy ? "正在重新整理..." : "重新生成文案"}</button><button type="button" onClick={copyFullScript} className="rounded-xl bg-[#0e7548] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#095c38]">{copied ? "✓ 已复制" : "复制完整脚本"}</button></div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">视频主题</p><p className="mt-2 text-lg font-bold leading-8 text-[#173a2b]">{selectedPlan.theme}</p></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">推荐标题</p><p className="mt-2 text-lg font-bold leading-8 text-[#173a2b]">{selectedPlan.title}</p></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">适合目的</p><p className="mt-2 text-sm leading-7 text-[#426151]">{selectedPlan.purpose}</p></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">黄金3秒开头</p><p className="mt-2 text-sm font-semibold leading-7 text-[#173a2b]">{selectedPlan.hook}</p></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5 sm:col-span-2"><p className="text-xs font-bold text-[#769282]">拍摄素材建议</p><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-7 text-[#426151]">{selectedPlan.materials.map((material, index) => <li key={index}>{material}</li>)}</ol></div>
          <div className="rounded-2xl border border-[#a9d9b6] bg-white p-5 sm:col-span-2"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-[#769282]">60秒口播脚本</p><span className="text-xs text-[#8aa095]">可以直接修改，修改内容会用于后续配音和成片</span></div><textarea value={scriptDraft} onChange={(event) => setScriptDraft(event.target.value)} rows={12} className="field mt-3 min-h-[260px] resize-y text-sm leading-8" placeholder="请填写口播文案" /></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5 sm:col-span-2"><p className="text-xs font-bold text-[#769282]">发布文案</p><p className="mt-3 whitespace-pre-line text-sm leading-7 text-[#426151]">{selectedPlan.caption}</p></div>
          <div className="rounded-2xl border border-[#d9e9df] bg-white p-5 sm:col-span-2"><p className="text-xs font-bold text-[#769282]">热门标签</p><div className="mt-3 flex flex-wrap gap-2">{selectedPlan.hashtags.map((tag) => <span key={tag} className="rounded-full bg-[#e4f7ea] px-3 py-1.5 text-xs font-semibold text-[#0e7548]">{tag}</span>)}</div></div>
        </div>
        {productionStatus === "idle" && <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-[#cfe9d6] bg-white p-5 text-center sm:flex-row sm:justify-between sm:text-left"><div><p className="font-bold text-[#173a2b]">文案确认后就可以制作</p><p className="mt-1 text-sm text-[#607d6b]">检查或修改上面的口播文案，确认后自动完成配音、字幕、混剪和封面。</p>{taskError && <p role="alert" className="mt-2 text-sm text-[#b94c32]">{taskError}</p>}</div><button type="button" onClick={startVideoGeneration} disabled={remainingCount === 0} className="w-full rounded-xl bg-[#f29b4b] px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#df8434] disabled:cursor-not-allowed disabled:bg-[#d7e6db] disabled:text-[#789184] sm:w-auto">{remainingCount === 0 ? "今日次数已用完" : "确认生成视频 →"}</button></div>}
      </section>}

      {productionStatus === "processing" && <section className="mt-8 rounded-[2rem] border border-[#cfe9d6] bg-white p-6 shadow-soft sm:p-10">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0e7548]">正在制作</p><h2 className="mt-3 text-2xl font-bold text-[#173a2b] sm:text-3xl">正在制作你的短视频</h2></div><p className="text-sm font-semibold text-[#607d6b]">第 {Math.min(activeStep + 1, videoSteps.length)} 步 / 共 {videoSteps.length} 步</p></div>
        <div className="mt-7 h-2 overflow-hidden rounded-full bg-[#e4f1e7]"><div className="h-full rounded-full bg-[#0e7548] transition-all duration-500" style={{ width: `${(activeStep / videoSteps.length) * 100}%` }} /></div>
        <ol className="mt-7 grid gap-3 sm:grid-cols-2">
          {videoSteps.map((step, index) => { const done = index < activeStep; const current = index === activeStep; return <li key={step} className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm ${done ? "bg-[#edf9f0] text-[#0e7548]" : current ? "bg-[#fff6e9] font-bold text-[#a65e1e]" : "bg-[#f7faf8] text-[#9aaa9f]"}`}><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-current text-xs">{done ? "✓" : index + 1}</span><span>{step}</span>{current && <span className="ml-auto animate-pulse">●●●</span>}</li>; })}
        </ol>
      </section>}

      {productionStatus === "completed" && selectedPlan && <section className="mt-8 rounded-[2rem] border-2 border-[#7cc891] bg-[#f0fbf3] p-6 shadow-soft sm:p-10">
        <div className="flex flex-wrap items-start justify-between gap-5 border-b border-[#cfe9d6] pb-7"><div><p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0e7548]">视频已生成</p><h2 className="mt-3 text-2xl font-bold text-[#173a2b] sm:text-3xl">你的AI短视频已经完成</h2><p className="mt-2 text-sm text-[#607d6b]">{shopName} · 已根据“{selectedPlan.type}”方案生成，可以直接下载发布。</p></div><span className="rounded-full bg-[#dff4e4] px-3 py-1.5 text-xs font-bold text-[#0e7548]">制作完成</span></div>
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(220px,0.75fr)_1.25fr] lg:items-center"><div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-[1.75rem] border-8 border-[#173a2b] bg-[#173a2b] shadow-xl"><div className="aspect-[9/16] bg-[#dff4e4]">{videoUrl || previewUrl ? <video controls preload="metadata" src={videoUrl || previewUrl} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center p-6 text-center text-sm font-semibold text-[#0e7548]">视频预览</div>}</div></div><div className="space-y-5"><div><p className="text-xs font-bold text-[#769282]">店铺名称</p><p className="mt-2 text-xl font-bold leading-8 text-[#173a2b]">{shopName}</p></div><div><p className="text-xs font-bold text-[#769282]">本次视频主题</p><p className="mt-2 text-xl font-bold leading-8 text-[#173a2b]">{selectedPlan.theme}</p></div><div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">推荐发布标题</p><p className="mt-2 font-semibold leading-7 text-[#304f3d]">{selectedPlan.title}</p></div>{voiceUrl && <div className="rounded-2xl border border-[#d9e9df] bg-white p-5"><p className="text-xs font-bold text-[#769282]">配音试听</p><audio controls preload="metadata" src={voiceUrl} className="mt-3 w-full" /></div>}<p className="text-sm leading-7 text-[#607d6b]">这版视频使用你上传的素材和已选方案制作。</p></div></div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2"><div className="rounded-2xl border border-[#cfe9d6] bg-white p-5 sm:col-span-2"><p className="text-xs font-bold text-[#769282]">使用的文案</p><p className="mt-3 whitespace-pre-line text-sm leading-8 text-[#304f3d]">{scriptDraft}</p></div><div className="rounded-2xl border border-[#cfe9d6] bg-white p-5"><p className="text-xs font-bold text-[#769282]">视频封面</p><p className="mt-2 text-sm leading-7 text-[#426151]">已自动使用店铺素材制作封面，并加入视频开头。</p></div><div className="overflow-hidden rounded-2xl border border-[#cfe9d6] bg-[#173a2b] p-3"><p className="px-2 pb-2 text-xs font-bold text-white/80">封面预览</p>{videoUrl ? <video muted playsInline preload="metadata" src={videoUrl} className="aspect-[9/16] max-h-48 w-full rounded-xl object-cover" /> : <div className="grid aspect-[9/16] max-h-48 place-items-center rounded-xl bg-[#dff4e4] text-sm text-[#0e7548]">封面预览</div>}</div></div>
        <div className="mt-8 flex flex-col gap-4 border-t border-[#cfe9d6] pt-7 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm font-semibold text-[#607d6b]">想每天生成更多视频？<span className="ml-1 text-[#0e7548]">升级老板会员</span><span className="ml-2 text-xs font-normal text-[#8aa095]">（即将开放）</span></p><div className="flex flex-col gap-3 sm:flex-row"><a href={videoUrl ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1` : undefined} download="老板AI短视频.mp4" aria-disabled={!videoUrl} className={`rounded-xl px-6 py-3 text-center text-sm font-bold transition ${videoUrl ? "bg-[#0e7548] text-white hover:bg-[#095c38]" : "pointer-events-none bg-[#d7e6db] text-[#789184]"}`}>下载视频</a><button type="button" onClick={startVideoGeneration} className="rounded-xl border border-[#0e7548] px-6 py-3 text-sm font-bold text-[#0e7548] transition hover:bg-[#e8f4eb]">重新生成</button></div></div>
      </section>}
    </section>
  );
}

export default function Home() {
  const [form, setForm] = useState({ shop_name: "", industry: "", city: "", specialty: "" });
  const [voice, setVoice] = useState("zh-CN-XiaoxiaoNeural");
  const [files, setFiles] = useState<File[]>([]);
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [userId, setUserId] = useState("");
  const [remainingCount, setRemainingCount] = useState<number | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState("");
  const [voicePreviewError, setVoicePreviewError] = useState("");
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioUrlRef = useRef("");
  const previewAudioCachedRef = useRef(false);
  const previewAudioCacheRef = useRef(new Map<string, string>());

  useEffect(() => {
    setShowWelcome(window.localStorage.getItem("boss-ai-welcome-seen") !== "1");
  }, []);

  useEffect(() => {
    const anonymousUserId = getOrCreateAnonymousUserId();
    setUserId(anonymousUserId);
    void fetch(`${API_URL}/usage?user_id=${encodeURIComponent(anonymousUserId)}`)
      .then((response) => response.ok ? response.json() as Promise<UsageResult> : null)
      .then((payload) => { if (payload) setRemainingCount(payload.remaining_count); })
      .catch(() => setRemainingCount(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const option of voiceOptions) {
      void fetch(`${API_URL}/voice-preview/${option.id}`)
        .then((response) => response.ok ? response.blob() : null)
        .then((blob) => {
          if (!blob || cancelled) return;
          const url = URL.createObjectURL(blob);
          previewAudioCacheRef.current.set(option.id, url);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      previewAudioCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewAudioCacheRef.current.clear();
    };
  }, []);

  useEffect(() => () => {
    previewAudioRef.current?.pause();
    if (previewAudioUrlRef.current && !previewAudioCachedRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
  }, []);

  const closeWelcome = () => {
    window.localStorage.setItem("boss-ai-welcome-seen", "1");
    setShowWelcome(false);
  };

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  };

  const scrollToGeneration = () => {
    document.getElementById("generation-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const allUploadsCompleted = files.length > 0 && materialIds.length === files.length && uploadItems.length === files.length && uploadItems.every((item) => item.status === "上传完成");
  const usedCount = remainingCount === null ? null : Math.max(0, 1 - remainingCount);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (!selectedFiles.length) return;
    const invalidFile = selectedFiles.find((selected) => {
      const looksLikeVideo = selected.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(selected.name);
      return selected.type && !looksLikeVideo;
    });
    if (invalidFile) {
      setError("请选择视频文件，例如 MP4、MOV 或 WebM。");
      return;
    }
    setFiles(selectedFiles);
    setMaterialIds([]);
    setUploadItems(selectedFiles.map((file, index) => ({ id: `${file.name}-${index}`, fileName: file.name, progress: 0, status: "等待上传" })));
    setResult(null);
    setError("");
    window.setTimeout(() => { void uploadFiles(selectedFiles); }, 0);
  };

  const previewVoice = async (voiceId: string) => {
    setVoicePreviewError("");
    previewAudioRef.current?.pause();
    if (previewAudioUrlRef.current) {
      if (!previewAudioCachedRef.current) URL.revokeObjectURL(previewAudioUrlRef.current);
      previewAudioUrlRef.current = "";
    }
    setPreviewingVoice(voiceId);
    try {
      let url = previewAudioCacheRef.current.get(voiceId);
      const cached = Boolean(url);
      if (!url) {
        const response = await fetch(`${API_URL}/voice-preview/${voiceId}`);
        if (!response.ok) throw new Error("试听失败，请稍后重试。");
        url = URL.createObjectURL(await response.blob());
      }
      previewAudioUrlRef.current = url;
      previewAudioCachedRef.current = cached;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => {
        setPreviewingVoice("");
        if (!cached) URL.revokeObjectURL(url);
        previewAudioUrlRef.current = "";
        previewAudioCachedRef.current = false;
        previewAudioRef.current = null;
      };
      await audio.play();
    } catch {
      setPreviewingVoice("");
      setVoicePreviewError("试听失败，请稍后重试。");
    }
  };

  const updateUploadItem = (index: number, patch: Partial<UploadItem>) => {
    setUploadItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };

  const uploadFiles = async (sourceFiles: File[] = files) => {
    if (!sourceFiles.length) return [];
    setUploading(true);
    setError("");
    setUploadItems(sourceFiles.map((file, index) => ({ id: `${file.name}-${index}`, fileName: file.name, progress: 0, status: "等待上传" })));
    try {
      const uploadedIds: string[] = [];
      for (let index = 0; index < sourceFiles.length; index += 1) {
        const file = sourceFiles[index];
        updateUploadItem(index, { status: "上传中", progress: 0 });
        try {
          const payload = await uploadFileWithProgress(file, (progress) => updateUploadItem(index, { progress }));
          uploadedIds.push(payload.file_id);
          updateUploadItem(index, { status: "上传完成", progress: 100 });
        } catch (uploadError) {
          updateUploadItem(index, { status: "上传失败" });
          throw uploadError;
        }
      }
      setMaterialIds(uploadedIds);
      return uploadedIds;
    } catch (uploadError) {
      setError(friendlyErrorMessage(uploadError, "素材上传失败，请稍后重试。"));
      return [];
    } finally {
      setUploading(false);
    }
  };

  const generateCopy = async () => {
    setError("");
    setResult(null);
    if (Object.values(form).some((value) => !value.trim())) {
      setError("请先把店铺信息填写完整。");
      return;
    }
    if (!files.length && !materialIds.length) {
      setError("请先上传店铺视频素材。");
      return;
    }
    if (uploading || materialIds.length !== files.length) {
      setError("请等待所有视频素材上传完成。");
      return;
    }
    const currentMaterialIds = materialIds;
    if (!currentMaterialIds.length) return;
    setGenerating(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, material_id: currentMaterialIds[0], user_id: userId }), signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("AI正在重新整理方案，请稍后重试。");
      if (!Array.isArray(payload.plans) || payload.plans.length !== 3) throw new Error("AI正在重新整理方案，请稍后重试。");
      setResult(payload as GenerateResult);
    } catch (generateError) {
      setError(generateError instanceof DOMException && generateError.name === "AbortError" ? "AI正在重新整理方案，请稍后重试。" : "AI正在重新整理方案，请稍后重试。");
    } finally {
      window.clearTimeout(timeoutId);
      setGenerating(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await generateCopy();
  };

  return (
    <main className="min-h-screen overflow-hidden">
      {showWelcome && <section className="border-b border-[#cfe9d6] bg-[#f0fbf3] px-5 py-5 sm:px-8"><div className="mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-lg font-bold text-[#173a2b]">欢迎使用AI短视频助手</p><p className="mt-2 text-sm leading-7 text-[#426151]">你只需要：① 上传手机拍摄的视频　② AI自动生成内容　③ 下载发布到抖音</p><p className="mt-1 text-xs text-[#6f8b7b]">不会剪辑也没关系，店里的日常素材就能做成短视频。</p></div><button type="button" onClick={closeWelcome} className="shrink-0 rounded-xl bg-[#0e7548] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#095c38]">知道了，开始制作</button></div></section>}
      <section className="relative bg-[#173a2b] text-white">
        <div className="mesh absolute inset-0 opacity-20" />
        <div className="relative mx-auto max-w-6xl px-5 pb-20 pt-7 sm:px-8 lg:px-10">
          <nav className="flex items-center justify-between"><div className="flex items-center gap-3 text-sm font-semibold tracking-wide"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#c7f2d6] text-lg text-[#173a2b]">✦</span>老板AI短视频助手</div><div className="flex items-center gap-2 sm:gap-3"><span className="rounded-full border border-[#baf0ca]/40 px-3 py-1.5 text-xs text-[#baf0ca]">今日体验：{usedCount === null ? "查询中" : `${usedCount}/1`}</span><Link href="/history" className="rounded-full border border-white/20 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10">我的作品</Link></div></nav>
          <div className="max-w-3xl pb-2 pt-16 sm:pt-28"><p className="mb-5 flex items-center gap-2 text-sm font-medium text-[#a8e9bd]"><span className="h-2 w-2 rounded-full bg-[#f9ae68]" /> 专为县城实体店老板打造</p><h1 className="text-4xl font-bold leading-[1.12] tracking-tight sm:text-6xl">不会剪视频？<br /><span className="text-[#baf0ca]">手机拍几个素材，AI自动帮你生成抖音视频</span></h1><p className="mt-6 max-w-2xl text-base leading-8 text-white/70 sm:text-lg">不用学习剪辑，不用找运营，上传店里的真实素材，AI自动生成文案、配音、字幕和视频。</p><button type="button" onClick={scrollToGeneration} className="mt-8 w-full rounded-2xl bg-[#f29b4b] px-6 py-4 text-base font-bold text-white shadow-lg transition hover:bg-[#df8434] sm:w-auto">免费生成我的第一个视频 <span aria-hidden="true">→</span></button></div>
          <div className="mt-12 grid gap-5 border-t border-white/15 pt-6 sm:grid-cols-3">{steps.map((step) => <div key={step.number} className="flex gap-3"><span className="text-xs font-bold text-[#f9ae68]">{step.number}</span><div><p className="text-sm font-semibold">{step.title}</p><p className="mt-1 text-xs leading-5 text-white/50">{step.text}</p></div></div>)}</div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 lg:px-10 lg:py-16"><div className="max-w-2xl"><p className="text-sm font-bold uppercase tracking-[0.2em] text-[#0e7548]">老板真实案例</p><h2 className="mt-3 text-3xl font-bold tracking-tight text-[#173a2b] sm:text-4xl">看看普通老板如何用AI做短视频</h2><p className="mt-4 text-sm leading-7 text-[#607d6b]">不用专业设备，店里每天拍下来的真实画面，就能变成有人愿意看的抖音内容。</p></div><div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{industryCases.map((item) => <article key={item.industry} className="overflow-hidden rounded-3xl border border-[#d9e9df] bg-white shadow-sm"><div className={`flex h-32 items-center justify-center bg-gradient-to-br ${item.color}`}><span className="text-5xl" role="img" aria-label={item.industry}>{item.emoji}</span></div><div className="p-5"><p className="text-xs font-bold text-[#0e7548]">{item.industry}</p><p className="mt-3 text-xs leading-5 text-[#8aa095]">原始素材：{item.source}</p><p className="mt-4 text-sm font-bold leading-6 text-[#173a2b]">AI生成：{item.title}</p></div></article>)}</div></section>

      <section id="generation-form" className="scroll-mt-5 mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[1fr_1.12fr] lg:px-10 lg:py-20">
        <div className="pt-2"><p className="text-sm font-bold uppercase tracking-[0.2em] text-[#0e7548]">Step 01 / 第一步</p><h2 className="mt-4 text-3xl font-bold tracking-tight text-[#17241f] sm:text-4xl">告诉AI你的生意</h2><p className="mt-5 max-w-md text-sm leading-7 text-[#60746a]">先填写店铺名称、行业类型和店铺介绍。信息越像平时聊天，AI生成的内容就越贴近你的真实生意。</p><div className="mt-10 rounded-3xl bg-[#e4f7ea] p-6 sm:p-7"><p className="text-xs font-bold tracking-[0.16em] text-[#0e7548]">你可以这样介绍</p><p className="mt-3 text-sm leading-7 text-[#355645]">店铺：成都XX烧烤店<br />介绍：主营烧烤、夜宵、朋友聚餐</p></div></div>

        <form onSubmit={handleSubmit} className="rounded-[2rem] border border-[#d9e9df] bg-white p-5 shadow-soft sm:p-8">
          <div className="grid gap-5 sm:grid-cols-2"><label className="block sm:col-span-2"><span className="mb-2 block text-sm font-semibold">店铺名称</span><input required value={form.shop_name} onChange={(event) => updateField("shop_name", event.target.value)} placeholder="比如：成都XX烧烤店" className="field" /></label><label className="block"><span className="mb-2 block text-sm font-semibold">行业类型</span><input required value={form.industry} onChange={(event) => updateField("industry", event.target.value)} placeholder="比如：餐饮美食" className="field" /></label><label className="block"><span className="mb-2 block text-sm font-semibold">所在城市</span><input required value={form.city} onChange={(event) => updateField("city", event.target.value)} placeholder="比如：成都" className="field" /></label><label className="block sm:col-span-2"><span className="mb-2 block text-sm font-semibold">店铺介绍</span><textarea required rows={3} value={form.specialty} onChange={(event) => updateField("specialty", event.target.value)} placeholder="比如：主营烧烤、夜宵、朋友聚餐" className="field resize-none" /></label></div>
          <div className="mt-6 border-t border-[#edf2ee] pt-6"><span className="mb-3 block text-sm font-bold text-[#173a2b]">选择配音声音</span><p className="mb-4 text-xs text-[#779084]">选一个你喜欢的声音，先试听，生成的视频会使用你选中的声音。</p><div className="grid gap-4 sm:grid-cols-2">{(["男声", "女声"] as const).map((group) => <div key={group} className="rounded-2xl border border-[#d9e9df] bg-[#f8fcf9] p-4"><p className="mb-3 text-sm font-bold text-[#173a2b]">{group}</p><div className="grid gap-2">{voiceOptions.filter((option) => option.group === group).map((option) => <div key={option.id} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 transition ${voice === option.id ? "border-[#0e7548] bg-[#edf9f0]" : "border-white bg-white"}`}><button type="button" onClick={() => setVoice(option.id)} aria-pressed={voice === option.id} className="min-w-0 flex-1 text-left"><span className="block text-sm font-semibold text-[#173a2b]">{option.label}</span><span className="mt-0.5 block text-xs leading-5 text-[#779084]">{option.hint}</span></button><button type="button" onClick={() => void previewVoice(option.id)} className="shrink-0 rounded-lg border border-[#b9dac2] px-2.5 py-1.5 text-xs font-bold text-[#0e7548] transition hover:bg-[#e4f7ea]">{previewingVoice === option.id ? "试听中…" : "试听"}</button></div>)}</div></div>)}</div>{voicePreviewError && <p role="alert" className="mt-3 text-xs text-[#b94c32]">{voicePreviewError}</p>}</div>
          <div className="mt-6 border-t border-[#edf2ee] pt-6"><span className="mb-2 block text-sm font-bold text-[#173a2b]">Step 02 / 上传你手机里的视频</span><p className="mb-4 text-sm leading-6 text-[#607d6b]">不用整理素材，随手拍的视频即可。智能助手会自动完成剪辑、配音、字幕。</p><label className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#a9cbb5] bg-[#f6fbf7] px-5 py-8 text-center transition hover:border-[#0e7548] hover:bg-[#edf9f0]"><input type="file" accept="video/*" multiple onChange={handleFile} className="sr-only" /><span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#dff8e9] text-3xl text-[#0e7548]">↥</span><span className="mt-4 max-w-full truncate text-sm font-semibold text-[#254b36]">{files.length ? `已选择 ${files.length} 个视频素材` : "点击上传店铺视频"}</span><span className="mt-1 text-xs text-[#779084]">不用整理素材，随手拍的视频即可。AI会自动完成剪辑、配音、字幕。</span><span className="mt-1 text-xs text-[#779084]">店铺环境 · 产品展示 · 制作过程 · 服务过程 · 顾客场景</span></label>{uploadItems.length > 0 && <div className="mt-4 space-y-2">{uploadItems.map((item) => <div key={item.id} className="rounded-xl border border-[#e3eee6] bg-white px-3 py-2.5"><div className="flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate font-semibold text-[#355645]">{item.fileName}</span><span className={item.status === "上传失败" ? "text-[#b94c32]" : item.status === "上传完成" ? "text-[#0e7548]" : "text-[#779084]"}>{item.status === "上传中" ? `正在上传视频 ${item.progress}%` : item.status}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e4f1e7]"><div className={`h-full rounded-full transition-all ${item.status === "上传失败" ? "bg-[#d9795b]" : "bg-[#0e7548]"}`} style={{ width: `${item.progress}%` }} /></div></div>)}</div>}{allUploadsCompleted && !uploading && <p className="mt-3 text-sm font-semibold text-[#0e7548]">素材上传完成，可以开始生成</p>}</div>
          {error && <p role="alert" className="mt-4 rounded-xl bg-[#fff0eb] px-4 py-3 text-sm leading-6 text-[#b94c32]">{error}</p>}{allUploadsCompleted && <button type="submit" disabled={generating} className="sticky bottom-3 z-20 mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#0e7548] px-5 py-4 text-base font-bold text-white shadow-xl transition hover:bg-[#095c38] disabled:cursor-wait disabled:opacity-60 sm:static sm:shadow-sm">{generating ? "正在生成爆款文案..." : "生成我的短视频 →"}</button>}{allUploadsCompleted && <p className="mt-2 text-center text-xs text-[#8aa095]">预计30秒生成完成</p>}{!allUploadsCompleted && !uploading && files.length > 0 && <p className="mt-6 rounded-xl bg-[#f6fbf7] px-4 py-3 text-center text-xs text-[#607d6b]">全部素材上传完成后，就可以生成你的短视频。</p>}<p className="mt-3 text-center text-xs text-[#8aa095]">先生成三套方案，再选择最适合你店铺的一套视频</p>
        </form>
      </section>

      {result && <PlanCards result={result} sourceFiles={files} materialIds={materialIds} shopName={form.shop_name} voice={voice} userId={userId} remainingCount={remainingCount} onRegenerateCopy={generateCopy} onGenerationCreated={() => setRemainingCount(0)} />}
      <footer className="mx-auto flex max-w-6xl flex-col gap-2 border-t border-[#dfebe3] px-5 py-7 text-xs text-[#8aa095] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10"><span>老板AI短视频助手 · V1.0.1 MVP</span><span>先让附近的人，知道你的店。</span></footer>
    </main>
  );
}
