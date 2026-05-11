/**
 * lib/embeddings.ts
 *
 * 极简的 Gemini Embeddings 客户端，直接调用 Google Generative Language API：
 *   - 使用 `gemini-embedding-001`（当前 API Key 实际能用的稳定 embedding 模型）
 *   - 通过 outputDimensionality 让 API 直接返回 768 维（与现有 Pinecone 索引对齐）
 *
 * 为什么不直接用 @langchain/google-genai 的 GoogleGenerativeAIEmbeddings？
 *   1. 该版本不暴露 outputDimensionality（默认 3072 维，与索引 768 不匹配）
 *   2. 其 embedDocuments 在 API 失败时会静默吞错误返回 []，难以排查
 */

import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";

export interface GeminiEmbeddingsParams extends EmbeddingsParams {
  apiKey: string;
  model?: string;
  outputDimensionality?: number;
}

export class GeminiEmbeddings extends Embeddings {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly outputDimensionality: number;

  constructor(params: GeminiEmbeddingsParams) {
    super(params);
    if (!params.apiKey) throw new Error("GeminiEmbeddings: apiKey is required");
    this.apiKey = params.apiKey;
    this.model = params.model ?? "gemini-embedding-001";
    this.outputDimensionality = params.outputDimensionality ?? 768;
  }

  private endpoint(action: "embedContent" | "batchEmbedContents") {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:${action}?key=${this.apiKey}`;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(this.endpoint("embedContent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: this.outputDimensionality,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[GeminiEmbeddings] embedContent ${res.status}: ${await res.text()}`
      );
    }
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const v = data.embedding?.values;
    if (!v?.length) throw new Error(`[GeminiEmbeddings] empty embedding`);
    return v;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.endpoint("batchEmbedContents"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.outputDimensionality,
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[GeminiEmbeddings] batchEmbedContents ${res.status}: ${await res.text()}`
      );
    }
    const data = (await res.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    const vecs = data.embeddings?.map((e) => e.values ?? []) ?? [];
    if (vecs.length !== texts.length || vecs.some((v) => !v.length)) {
      throw new Error(`[GeminiEmbeddings] malformed batch response`);
    }
    return vecs;
  }
}
