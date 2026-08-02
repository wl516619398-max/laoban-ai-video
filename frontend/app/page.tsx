"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { getApiUrl } from "../lib/api";
import VideoProductionPanel from "./video-production-panel";

type FormValues = {
  shop_name: string;
  industry: string;
  city: string;
  specialty: string;
  detail: string;
};

type VideoPlan = {
  type?: string;
  theme?: string;
  hook?: string;
  title?: string;
  visual?: string;
  purpose?: string;
  materials?: string[];
  script?: string;
  storyboard?: Array<unknown>;
  caption?: string;
  hashtags?: string[];
};

type GenerateResponse = { plans?: VideoPlan[]; detail?: string };
type MaterialUploadStatus = "等待上传" | "上传中" | "上传完成" | "上传失败";
type MaterialUpload = {
  id: string;
  file: File;
  fileId: string;
  progress: number;
  status: MaterialUploadStatus;
};
type UsageResponse = {
  app_env?: string;
  daily_limit?: number;
  used_count?: number;
  remaining_count?: number;
};

type VoiceOption = {
  id: string;
  name: string;
  group: "男声" | "女声";
  scene: string;
};

const voiceOptions: VoiceOption[] = [
  { id: "zh-CN-YunxiNeural", name: "老板亲切声", group: "男声", scene: "适合老板日常分享、门店介绍" },
  { id: "zh-CN-YunjianNeural", name: "沉稳专业声", group: "男声", scene: "适合讲经营年头、产品特点" },
  { id: "zh-CN-YunyangNeural", name: "活力年轻声", group: "男声", scene: "适合热闹门店、活动内容" },
  { id: "zh-CN-YunyeNeural", name: "故事分享声", group: "男声", scene: "适合老板经历、本地故事" },
  { id: "zh-CN-YunhaoNeural", name: "真实口播声", group: "男声", scene: "适合手机随手拍、自然聊天" },
  { id: "zh-CN-YunfengNeural", name: "清晰讲解声", group: "男声", scene: "适合服务流程、细节说明" },
  { id: "zh-CN-XiaoxiaoNeural", name: "温柔客服声", group: "女声", scene: "适合服务介绍、顾客沟通" },
  { id: "zh-CN-XiaomoNeural", name: "知性介绍声", group: "女声", scene: "适合产品特点、品质说明" },
  { id: "zh-CN-XiaoyiNeural", name: "活泼营销声", group: "女声", scene: "适合新品推荐、到店引导" },
  { id: "zh-CN-XiaoxuanNeural", name: "邻家亲切声", group: "女声", scene: "适合本地生活、轻松分享" },
  { id: "zh-CN-XiaohanNeural", name: "甜美聊天声", group: "女声", scene: "适合生活场景、顾客故事" },
  { id: "zh-CN-XiaoruiNeural", name: "亲切老板娘声", group: "女声", scene: "适合店铺日常、老板娘出镜" },
];

const initialForm: FormValues = {
  shop_name: "成都老火锅",
  industry: "餐饮",
  city: "成都",
  specialty: "牛油火锅",
  detail: "开了10年的老店",
};

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

function uploadFileWithProgress(file: File, onProgress: (progress: number) => void) {
  return new Promise<{ file_id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const body = new FormData();
    body.append("file", file);
    const uploadUrl = `${getApiUrl()}/upload`;

    xhr.open("POST", uploadUrl);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      console.log("[upload] response", { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 });
      const payload = (() => {
        try {
          return JSON.parse(xhr.responseText || "{}");
        } catch {
          return {};
        }
      })() as { file_id?: string; detail?: string };
      if (xhr.status < 200 || xhr.status >= 300 || !payload.file_id) {
        reject(new Error(getErrorMessage(payload, "上传失败，请稍后重试。")));
        return;
      }
      onProgress(100);
      resolve({ file_id: String(payload.file_id) });
    };
    xhr.onerror = () => reject(new Error("上传失败，请稍后重试。"));
    xhr.ontimeout = () => reject(new Error("上传超时，请稍后重试。"));
    xhr.onabort = () => reject(new Error("上传已取消，请稍后重试。"));
    xhr.send(body);
  });
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = String(payload.detail || "");
    if (detail && !/traceback|exception|internal server|deepseek|sqlite|ffmpeg/i.test(detail)) {
      return detail;
    }
  }
  return fallback;
}

function parsePlansResponse(payload: unknown): VideoPlan[] {
  const parse = (value: unknown, depth = 0): VideoPlan[] => {
    if (depth > 5 || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.filter((item): item is VideoPlan => typeof item === "object" && item !== null).slice(0, 3);
    if (typeof value === "string") {
      const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try {
        return parse(JSON.parse(text), depth + 1);
      } catch {
        return [];
      }
    }
    if (typeof value !== "object") return [];

    const record = value as Record<string, unknown>;
    for (const key of ["plans", "video_plans", "方案", "方案列表", "短视频方案"]) {
      const plans = parse(record[key], depth + 1);
      if (plans.length) return plans;
    }
    for (const key of ["data", "result", "output", "内容"]) {
      const plans = parse(record[key], depth + 1);
      if (plans.length) return plans;
    }

    const namedPlans = Object.entries(record)
      .map(([key, plan]) => {
        const normalized = key.replace(/[\s_\-:：，,。·/]+/g, "").toLowerCase();
        const order = normalized.match(/^(?:方案|plan)?([123])$/)?.[1] ||
          ({ a: "1", b: "2", c: "3" } as Record<string, string>)[normalized];
        return order && typeof plan === "object" && plan !== null ? { order: Number(order), plan: plan as VideoPlan } : null;
      })
      .filter((item): item is { order: number; plan: VideoPlan } => Boolean(item))
      .sort((left, right) => left.order - right.order)
      .map((item) => item.plan)
      .slice(0, 3);
    return namedPlans;
  };

  return parse(payload);
}

function planText(plan: VideoPlan) {
  return [
    `【方案类型】\n${plan.type || ""}`,
    `【视频主题】\n${plan.theme || ""}`,
    `【开头钩子】\n${plan.hook || ""}`,
    `【推荐标题】\n${plan.title || ""}`,
    `【完整口播文案】\n${plan.script || ""}`,
  ].join("\n\n");
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function PlanCard({ plan, index, selected, onSelect }: { plan: VideoPlan; index: number; selected: boolean; onSelect: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyScript = async () => {
    try {
      await copyText(plan.script || "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`plan-card ${selected ? "plan-card-selected" : ""}`}>
      <div className="plan-card-header">
        <span className="plan-number">方案 {index + 1}</span>
        <span className="plan-type">{plan.type || "短视频方案"}</span>
      </div>

      <div className="plan-content">
        <section>
          <p className="label">视频主题</p>
          <h3>{plan.theme || "暂无主题"}</h3>
        </section>

        <section className="highlight-box">
          <p className="label">开头钩子</p>
          <p>{plan.hook || "暂无开头钩子"}</p>
        </section>

        <section>
          <p className="label">推荐标题</p>
          <p className="title-text">{plan.title || "暂无推荐标题"}</p>
        </section>

        <section>
          <div className="script-heading">
            <p className="label">完整口播文案</p>
            <button type="button" className="copy-button" onClick={() => void copyScript()}>
              {copied ? "已复制" : "复制文案"}
            </button>
          </div>
          <p className="script-text">{plan.script || "暂无口播文案"}</p>
        </section>
      </div>

      <details className="more-details">
        <summary>查看更多方案信息</summary>
        <div className="more-content">
          {plan.purpose && <p><strong>适合目的：</strong>{plan.purpose}</p>}
          {plan.visual && <p><strong>推荐画面：</strong>{plan.visual}</p>}
          {!!plan.caption && <p><strong>发布文案：</strong>{plan.caption}</p>}
          {!!plan.materials?.length && <p><strong>拍摄建议：</strong>{plan.materials.join("、")}</p>}
          {!!plan.hashtags?.length && <p><strong>话题：</strong>{plan.hashtags.join(" ")}</p>}
        </div>
      </details>

      <button type="button" className="copy-all-button" onClick={async () => {
        try {
          await copyText(planText(plan));
        } catch {
          // 旧浏览器不支持剪贴板时，不影响方案查看。
        }
      }}>
        复制完整方案
      </button>
      <button type="button" className="select-plan-button" onClick={onSelect} aria-pressed={selected}>
        {selected ? "已选择此方案" : "选择此方案"}
      </button>
    </article>
  );
}

export default function Home() {
  const [form, setForm] = useState<FormValues>(initialForm);
  const [materials, setMaterials] = useState<MaterialUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [plans, setPlans] = useState<VideoPlan[]>([]);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [usageLoading, setUsageLoading] = useState(true);
  const [remainingCount, setRemainingCount] = useState<number | null>(null);
  const [voice, setVoice] = useState("zh-CN-YunxiNeural");
  const [previewingVoice, setPreviewingVoice] = useState("");
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const response = await fetch(`${getApiUrl()}/usage`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as UsageResponse;
      console.log("usage data:", data);
      if (!response.ok || typeof data.remaining_count !== "number") {
        throw new Error("次数状态暂时无法获取");
      }
      setRemainingCount(data.remaining_count);
      return data;
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const handleGenerationSuccess = useCallback(() => {
    void refreshUsage();
  }, [refreshUsage]);

  useEffect(() => {
    const loadInitialUsage = async () => {
      try {
        await refreshUsage();
      } catch {
        // 次数状态不影响上传和方案生成，失败时保持页面可用。
      }
    };
    void loadInitialUsage();
  }, [refreshUsage]);

  const updateField = (field: keyof FormValues, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const previewVoice = (voiceId: string) => {
    if (previewingVoice === voiceId) {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      setPreviewingVoice("");
      return;
    }

    previewAudioRef.current?.pause();
    const audio = new Audio(`${getApiUrl()}/voice-preview/${encodeURIComponent(voiceId)}`);
    audio.onended = () => setPreviewingVoice("");
    audio.onerror = () => {
      setPreviewingVoice("");
      setError("试听暂时不可用，请稍后再试。");
    };
    previewAudioRef.current = audio;
    setPreviewingVoice(voiceId);
    void audio.play().catch(() => {
      setPreviewingVoice("");
      setError("试听暂时不可用，请稍后再试。");
    });
  };

  const updateMaterial = (id: string, patch: Partial<MaterialUpload>) => {
    setMaterials((current) => current.map((material) => material.id === id ? { ...material, ...patch } : material));
  };

  const uploadMaterial = async (material: MaterialUpload) => {
    updateMaterial(material.id, { status: "上传中", progress: 0 });
    setMessage("正在上传素材...");
    setError("");
    const uploadUrl = `${getApiUrl()}/upload`;
    console.log("[upload] start", { url: uploadUrl, filename: material.file.name, size: material.file.size, timeoutMs: UPLOAD_TIMEOUT_MS });

    try {
      const payload = await uploadFileWithProgress(material.file, (progress) => updateMaterial(material.id, { progress }));
      console.log("[upload] success", { fileId: payload.file_id, filename: material.file.name });
      updateMaterial(material.id, { fileId: payload.file_id, progress: 100, status: "上传完成" });
    } catch (uploadError) {
      console.error("[upload] failed", uploadError);
      updateMaterial(material.id, { status: "上传失败" });
      setError(uploadError instanceof DOMException && uploadError.name === "AbortError" ? "上传超时，请稍后重试。" : uploadError instanceof Error ? uploadError.message : "上传失败，请稍后重试。");
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selectedFiles.length) return;

    const validFiles = selectedFiles.filter((file) => /\.(mp4|mov)$/i.test(file.name) || ["video/mp4", "video/quicktime"].includes(file.type));
    if (validFiles.length !== selectedFiles.length) {
      setError("部分文件不是 MP4 或 MOV 格式，已跳过不支持的文件。");
    } else {
      setError("");
    }
    if (!validFiles.length) return;

    const newMaterials = validFiles.map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${Date.now()}-${index}`,
      file,
      fileId: "",
      progress: 0,
      status: "等待上传" as MaterialUploadStatus,
    }));
    setMaterials((current) => [...current, ...newMaterials]);
    setUploading(true);
    void Promise.all(newMaterials.map((material) => uploadMaterial(material))).finally(() => setUploading(false));
  };

  const removeMaterial = (id: string) => {
    setMaterials((current) => current.filter((material) => material.id !== id));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const uploadedMaterialIds = materials.filter((material) => material.status === "上传完成" && material.fileId).map((material) => material.fileId);
    const allUploadsCompleted = materials.length > 0 && uploadedMaterialIds.length === materials.length;
    if (!allUploadsCompleted || uploading) {
      setError("请先上传一个 MP4 或 MOV 视频素材。");
      return;
    }
    if (!canGenerate) {
      setError(remainingCount === null ? "次数状态暂时无法获取，请稍后再试。" : "当前没有可用次数，请稍后再试。");
      return;
    }

    setGenerating(true);
    setPlans([]);
    setError("");
    setMessage("AI正在为你的店铺整理三套视频方案...");

    try {
      const response = await fetch(`${getApiUrl()}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, specialty: form.specialty, material_id: uploadedMaterialIds[0], voice }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, "生成失败，请稍后重试。"));
      }
      const parsedPlans = parsePlansResponse(payload);
      if (!parsedPlans.length) {
        throw new Error("暂时没有生成方案，请稍后重试。");
      }
      setPlans(parsedPlans);
      setSelectedPlanIndex(null);
      setMessage(`已生成 ${parsedPlans.length} 套视频方案，请选择最适合你店铺的一套。`);
      try {
        await refreshUsage();
      } catch {
        // 方案已经生成成功，次数状态读取失败不影响结果查看。
      }
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "生成失败，请稍后重试。");
      setMessage("");
    } finally {
      setGenerating(false);
    }
  };

  const canGenerate = !usageLoading && remainingCount !== null && remainingCount > 0;
  const uploadedMaterialIds = materials.filter((material) => material.status === "上传完成" && material.fileId).map((material) => material.fileId);
  const allUploadsCompleted = materials.length > 0 && uploadedMaterialIds.length === materials.length;
  const usageLabel = usageLoading
    ? "今日体验：正在获取次数"
    : remainingCount === 0
      ? "今日体验：已用完"
      : remainingCount !== null
        ? `今日体验：剩余 ${remainingCount} 次`
        : "今日体验：次数暂时无法获取";

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="brand-mark">AI</div>
        <div>
          <p className="brand-name">AI智能视频助手</p>
          <p className="brand-subtitle">帮助小县城老板快速生成短视频内容</p>
        </div>
        <span className="usage-pill">
          {usageLabel}
        </span>
      </header>

      <section className="hero">
        <span className="eyebrow">简单三步，做好一条短视频</span>
        <h1>老板拍素材，AI帮你写好短视频</h1>
        <p>填写店铺信息，上传手机里的真实视频，快速得到适合抖音发布的短视频方案。</p>
      </section>

      <form className="workflow-card" onSubmit={handleSubmit}>
        <div className="step-title"><span>1</span><div><h2>填写店铺信息</h2><p>让 AI 了解你的生意，生成内容会更贴近你的店。</p></div></div>

        <div className="form-grid">
          <label>
            <span>店铺名称</span>
            <input value={form.shop_name} onChange={(event) => updateField("shop_name", event.target.value)} placeholder="例如：成都老火锅" required />
          </label>
          <label>
            <span>行业</span>
            <input value={form.industry} onChange={(event) => updateField("industry", event.target.value)} placeholder="例如：餐饮" required />
          </label>
          <label>
            <span>城市</span>
            <input value={form.city} onChange={(event) => updateField("city", event.target.value)} placeholder="例如：成都" required />
          </label>
          <label>
            <span>特色介绍</span>
            <input value={form.specialty} onChange={(event) => updateField("specialty", event.target.value)} placeholder="例如：牛油火锅" required />
          </label>
          <label className="full-width">
            <span>补充说明</span>
            <textarea value={form.detail} onChange={(event) => updateField("detail", event.target.value)} placeholder="例如：开了10年的老店" rows={3} required />
          </label>
        </div>

        <div className="voice-section">
          <div className="voice-section-heading">
            <div>
              <h3>选择视频配音</h3>
              <p>不知道怎么选？先试听，选一个听起来最像你店里说话方式的声音。</p>
            </div>
            <span className="voice-selected">已选：{voiceOptions.find((option) => option.id === voice)?.name}</span>
          </div>
          <div className="voice-groups">
            {(["男声", "女声"] as const).map((group) => (
              <section className="voice-group" key={group}>
                <h4>{group}</h4>
                <div className="voice-grid">
                  {voiceOptions.filter((option) => option.group === group).map((option) => (
                    <div className={`voice-card ${voice === option.id ? "voice-card-selected" : ""}`} key={option.id}>
                      <button type="button" className="voice-choice" onClick={() => setVoice(option.id)} aria-pressed={voice === option.id}>
                        <span className="voice-name">{option.name}</span>
                        <span className="voice-scene">{option.scene}</span>
                      </button>
                      <button type="button" className="preview-button" onClick={() => previewVoice(option.id)}>
                        {previewingVoice === option.id ? "停止" : "试听"}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="step-title second-step"><span>2</span><div><h2>上传视频素材</h2><p>上传店里随手拍的视频即可，支持 MP4、MOV 格式。</p></div></div>

        <label className={`upload-box ${allUploadsCompleted ? "upload-success" : ""}`}>
          <input type="file" accept=".mp4,.mov,video/mp4,video/quicktime" multiple onChange={handleFileChange} />
          <span className="upload-icon">↑</span>
          <strong>{materials.length ? `已选择 ${materials.length} 个视频素材` : "点击选择视频素材"}</strong>
          <small>支持一次选择多个视频，也可以继续添加素材</small>
        </label>

        {materials.length > 0 && <div className="material-list">
          {materials.map((material) => <div className="material-item" key={material.id}>
            <div className="material-item-header"><span title={material.file.name}>{material.file.name}</span><button type="button" onClick={() => removeMaterial(material.id)}>删除</button></div>
            <div className="material-item-status">{material.status === "上传中" ? `正在上传 ${material.progress}%` : material.status}</div>
            <div className="upload-progress-track"><span style={{ width: `${material.progress}%` }} /></div>
          </div>)}
          {allUploadsCompleted && <p className="status-message">已上传 {materials.length} 个视频素材，可以生成方案。</p>}
        </div>}

        {message && <p className="status-message">{message}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="action-row">
          <button className="generate-button" type="submit" disabled={!allUploadsCompleted || uploading || generating || usageLoading || remainingCount === null || remainingCount === 0}>
            {generating ? "正在生成方案..." : "生成短视频方案"}
          </button>
          <span className="action-hint">{usageLoading ? "正在获取次数" : remainingCount === null ? "次数暂时无法获取" : canGenerate ? "AI 将为你生成 3 套方案" : "当前暂不能生成，请稍后再试"}</span>
        </div>
      </form>

      {plans.length > 0 && (
        <section className="results-section" aria-live="polite">
          <div className="results-heading">
            <span className="eyebrow">AI 生成结果</span>
            <h2>选择一套适合你店铺的方案</h2>
            <p>三套方案风格不同，你可以直接复制口播文案使用。</p>
          </div>
          <div className="plans-grid">
            {plans.map((plan, index) => <PlanCard key={`${plan.type || "plan"}-${index}`} plan={plan} index={index} selected={selectedPlanIndex === index} onSelect={() => setSelectedPlanIndex(index)} />)}
          </div>
          {selectedPlanIndex !== null && plans[selectedPlanIndex] && <VideoProductionPanel
            key={`${selectedPlanIndex}-${plans[selectedPlanIndex].title || plans[selectedPlanIndex].theme || "plan"}`}
            plan={plans[selectedPlanIndex]}
            storeInfo={form}
            materialIds={uploadedMaterialIds}
            materialNames={materials.map((material) => material.file.name)}
            shopName={form.shop_name}
            voice={voice}
            userId="legacy-anonymous-user"
            remainingCount={remainingCount}
            onGenerationSuccess={handleGenerationSuccess}
          />}
        </section>
      )}

      <footer className="footer">AI智能视频助手 · 让真实的小店，也能轻松做好短视频</footer>
    </main>
  );
}
