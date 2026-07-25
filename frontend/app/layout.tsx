import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "老板AI短视频助手",
  description: "让县城好生意，被更多人看见。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

