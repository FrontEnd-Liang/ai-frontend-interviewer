import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "前端面试官 · AI 问答",
  description: "极简 AI 问答工具：模拟前端技术面试官，结构化输出 JSON 卡片",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
