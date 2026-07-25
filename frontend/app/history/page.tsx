"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const USER_ID_STORAGE_KEY = "boss-ai-anonymous-user-id";

function getOrCreateAnonymousUserId() {
  const existing = window.localStorage.getItem(USER_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(USER_ID_STORAGE_KEY, generated);
  return generated;
}

type HistoryItem = {
  task_id: string;
  shop_name: string;
  plan_title: string;
  status: string;
  status_label: string;
  created_at: string;
  video_url?: string;
  voice_label?: string;
  download_status?: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export default function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const userId = getOrCreateAnonymousUserId();
        const response = await fetch(`${API_URL}/video-tasks?user_id=${encodeURIComponent(userId)}`);
        const payload = (await response.json().catch(() => ({}))) as { items?: HistoryItem[] };
        if (!response.ok) throw new Error("历史作品暂时无法加载，请稍后重试");
        setItems(payload.items || []);
      } catch {
        setError("历史作品暂时无法加载，请稍后重试");
      } finally {
        setLoading(false);
      }
    };
    void loadHistory();
  }, []);

  return (
    <main className="min-h-screen bg-[#f7fbf8] text-[#173a2b]">
      <header className="bg-[#173a2b] text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6 sm:px-8 lg:px-10">
          <Link href="/" className="flex items-center gap-3 text-sm font-semibold tracking-wide"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#c7f2d6] text-lg text-[#173a2b]">✦</span>老板AI短视频助手</Link>
          <Link href="/" className="text-sm text-white/70 transition hover:text-white">返回首页</Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8 lg:px-10 lg:py-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-[#0e7548]">My works / 我的作品</p><h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">我的作品</h1><p className="mt-3 text-sm leading-7 text-[#607d6b]">这里保存你生成过的短视频，随时回来播放或下载。</p></div>
          <Link href="/" className="rounded-xl bg-[#0e7548] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#095c38]">生成新视频</Link>
        </div>

        {loading && <div className="mt-10 rounded-3xl border border-[#d9e9df] bg-white p-10 text-center text-sm text-[#607d6b]">正在加载作品...</div>}
        {error && <p role="alert" className="mt-10 rounded-2xl bg-[#fff0eb] px-5 py-4 text-sm text-[#b94c32]">{error}</p>}
        {!loading && !error && !items.length && <div className="mt-10 rounded-3xl border border-dashed border-[#b8d6c1] bg-white p-12 text-center"><p className="text-lg font-bold">还没有生成作品</p><p className="mt-2 text-sm text-[#607d6b]">完成第一条短视频后，它会出现在这里。</p><Link href="/" className="mt-6 inline-flex rounded-xl bg-[#f29b4b] px-5 py-3 text-sm font-bold text-white">开始生成</Link></div>}

        {!!items.length && <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{items.map((item) => {
          const videoUrl = item.video_url ? `${API_URL}${item.video_url}` : "";
          const completed = Boolean(videoUrl);
          return <article key={item.task_id} className="overflow-hidden rounded-[1.5rem] border border-[#d9e9df] bg-white shadow-sm">
            <div className="relative aspect-[9/16] bg-[#e4f7ea]">{videoUrl ? <video muted preload="metadata" src={videoUrl} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center p-6 text-center text-sm font-semibold text-[#0e7548]">视频正在制作中</div>}<span className={`absolute left-3 top-3 rounded-full px-3 py-1.5 text-xs font-bold ${completed ? "bg-[#dff4e4] text-[#0e7548]" : "bg-white/90 text-[#a65e1e]"}`}>{item.status_label}</span></div>
            <div className="p-5"><p className="text-xs font-semibold text-[#769282]">{item.shop_name}</p><h2 className="mt-2 line-clamp-2 text-lg font-bold leading-7 text-[#173a2b]">{item.plan_title}</h2><p className="mt-2 text-xs text-[#8aa095]">{formatDate(item.created_at)}</p><div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#607d6b]"><span>声音：{item.voice_label || "默认声音"}</span><span>下载：{item.download_status || "未下载"}</span></div><div className="mt-5 flex gap-2"><a href={videoUrl || undefined} target={videoUrl ? "_blank" : undefined} rel={videoUrl ? "noreferrer" : undefined} className={`flex-1 rounded-xl px-3 py-2.5 text-center text-sm font-bold ${videoUrl ? "bg-[#0e7548] text-white hover:bg-[#095c38]" : "pointer-events-none bg-[#e6efe8] text-[#91a99a]"}`}>播放</a><a href={videoUrl ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1` : undefined} download="老板AI短视频.mp4" aria-disabled={!videoUrl} className={`flex-1 rounded-xl border px-3 py-2.5 text-center text-sm font-bold ${videoUrl ? "border-[#0e7548] text-[#0e7548] hover:bg-[#edf9f0]" : "pointer-events-none border-[#d9e9df] text-[#91a99a]"}`}>下载</a></div></div>
          </article>;
        })}</div>}
      </section>
    </main>
  );
}
