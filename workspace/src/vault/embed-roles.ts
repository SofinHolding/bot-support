/**
 * Mọi lời gọi embed của vault đi qua đây, mỗi hàm gắn CỐ ĐỊNH một vai trò (trang Notion "Xây dựng bộ nhớ LLM" mục 6):
 *   embedDocument     — chỉ indexer (lưu chunk)           task_type RETRIEVAL_DOCUMENT
 *   embedQuery        — chỉ search (câu hỏi khi tìm kiếm)  task_type RETRIEVAL_QUERY
 *   embedForChunking  — chỉ chunker (tìm điểm cắt)        task_type SEMANTIC_SIMILARITY
 * Code không tự nhận biết chữ là tài liệu hay câu hỏi: vai trò do luồng quyết định. tests/vault-index.test.ts chặn import chéo.
 * Vector luôn được chuẩn hoá L2 (vô hại với 3072 chiều đã chuẩn hoá sẵn; bắt buộc nếu sau này giảm số chiều).
 */
import { embedTagged, type EmbedTaskType, type Embedder } from "../core/embedding";

export function l2(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

async function embedAs(e: Embedder, texts: string[], taskType: EmbedTaskType): Promise<{ vectors: number[][]; model: string }> {
  const r = await embedTagged(e, texts, { taskType });
  return { vectors: r.vectors.map(l2), model: r.model };
}

export const embedDocument = (e: Embedder, texts: string[]) => embedAs(e, texts, "RETRIEVAL_DOCUMENT");
export const embedQuery = (e: Embedder, texts: string[]) => embedAs(e, texts, "RETRIEVAL_QUERY");
export const embedForChunking = (e: Embedder, texts: string[]) => embedAs(e, texts, "SEMANTIC_SIMILARITY");
