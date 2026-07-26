import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI智能视频助手",
  description: "帮助小县城老板快速生成短视频内容",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
