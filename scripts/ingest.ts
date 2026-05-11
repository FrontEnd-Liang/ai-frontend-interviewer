/**
 * scripts/ingest.ts
 *
 * 把 docs/frontend-handbook.md 切分后用 Gemini text-embedding-004 向量化，
 * 写入 Pinecone 索引（索引名取自 process.env.PINECONE_INDEX）。
 *
 * 运行：npm run ingest
 */

// 注意：dotenv 必须在所有"读取 process.env"的 import 之前执行
// （tsx 是 ESM，import 会 hoist，所以这里用 require 或者把环境变量逻辑放最前面）
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { GeminiEmbeddings } from "../lib/embeddings";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`[ingest] 缺少必填环境变量: ${name}（请检查 .env.local）`);
  }
  return v.trim();
}

async function main() {
  // 1. 国内访问 Google API 需要走代理（与 route.ts 同款逻辑）
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[ingest] using proxy: ${proxyUrl}`);
  }

  const geminiKey = requireEnv("GEMINI_API_KEY");
  const pineconeKey = requireEnv("PINECONE_API_KEY");
  const indexName = requireEnv("PINECONE_INDEX");

  // 2. 读取手册
  const docPath = path.resolve(process.cwd(), "docs/frontend-handbook.md");
  const raw = await fs.readFile(docPath, "utf-8");
  console.log(`[ingest] 读取 ${docPath}（${raw.length} 字符）`);

  // 3. 切分
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });
  const docs = await splitter.createDocuments(
    [raw],
    [{ source: "frontend-handbook.md" }]
  );
  console.log(`[ingest] 切分为 ${docs.length} 个 chunk`);

  // 4. Embedding：gemini-embedding-001，通过 outputDimensionality 截断到 768 维
  //    与 Pinecone 索引维度对齐（Matryoshka representation learning，质量无损）
  const embeddings = new GeminiEmbeddings({
    apiKey: geminiKey,
    model: "gemini-embedding-001",
    outputDimensionality: 768,
  });

  // 5. 写入 Pinecone
  const pinecone = new Pinecone({ apiKey: pineconeKey });
  const pineconeIndex = pinecone.Index(indexName);

  // 重复执行 ingest 时先清空，避免向量重复（serverless 空索引会 404，吞掉错误即可）
  try {
    await pineconeIndex.deleteAll();
    console.log(`[ingest] 已清空索引 "${indexName}" 中的旧向量`);
  } catch (err) {
    console.warn(`[ingest] deleteAll 跳过（可能索引本来就是空的）`);
  }

  await PineconeStore.fromDocuments(docs, embeddings, { pineconeIndex });
  console.log(`[ingest] ✓ 完成：${docs.length} 个 chunk 已写入 "${indexName}"`);
}

main().catch((err) => {
  console.error("[ingest] FAILED:", err);
  process.exit(1);
});
