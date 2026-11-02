// 사례 저장소: 최종 승인된 결정 기록을 모아 두고, 같은 상품 종류의 비슷한 사례를 예시로 꺼낸다(ADR-0011). 학습은 하지 않는다.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as lancedb from "@lancedb/lancedb";

import type { CaseRecord, Intake } from "./runner.ts";
import type { ProductKind } from "./schemas.ts";

/** 저장된 사례. id로 사례를 뺀다. */
export type StoredCase = CaseRecord & { id: string };

/** 문장마다 임베딩 벡터 하나. 운영에서는 LiteLLM 임베딩 모델(liteLlmEmbed)이다. */
export type Embed = (texts: string[]) => Promise<number[][]>;

export interface CaseStore {
  /** 사례를 기록하고 그 id를 돌려준다 */
  record(record: CaseRecord): Promise<string>;
  /** 그 상품 종류의 사례 중 query와 임베딩 유사도가 높은 순서로 limit개 */
  similar(kind: ProductKind, query: string, limit: number): Promise<CaseRecord[]>;
  /** 기록된 순서대로 모든 사례 */
  list(): Promise<StoredCase[]>;
  /** 뺀 사례는 다음 similar부터 나오지 않는다 */
  remove(id: string): Promise<void>;
}

/** 임베딩할 정보 입력의 문장. 사례도 지금 상품도 이 문장으로 임베딩해야 유사도가 뜻을 가진다. */
export function caseQuery(intake: Intake): string {
  return [intake.kind, intake.name, intake.memo].join("\n");
}

/** AI 입력에는 id를 싣지 않는다 */
export function recordOf({ id: _id, ...record }: StoredCase): CaseRecord {
  return record;
}

function cosine(a: number[], b: number[]): number {
  let [dot, na, nb] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** 메모리 사례 저장소. 시험과 개발용이다. 유사도가 같으면 먼저 기록된 사례가 앞선다. */
export function memoryCaseStore(embed: Embed = ngramEmbedding): CaseStore {
  const cases: StoredCase[] = [];
  return {
    record: async (record) => {
      const id = randomUUID();
      cases.push(structuredClone({ ...record, id }));
      return id;
    },
    similar: async (kind, query, limit) => {
      const same = cases.filter((c) => c.kind === kind);
      if (same.length === 0) return [];
      const [q, ...vectors] = await embed([query, ...same.map((c) => caseQuery(c.intake))]);
      return same
        .map((c, i) => ({ c, score: cosine(q, vectors[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ c }) => structuredClone(recordOf(c)));
    },
    list: async () => structuredClone(cases),
    remove: async (id) => {
      const i = cases.findIndex((c) => c.id === id);
      if (i >= 0) cases.splice(i, 1);
    },
  };
}

/** 기본 사례 저장소 폴더. 저장소 루트의 data/는 .gitignore에 있어 공개 저장소에 올라가지 않는다. */
export const DEFAULT_CASES_DIR = fileURLToPath(new URL("../../data/cases/", import.meta.url));

/** LanceDB 색인의 한 줄. 사례 본문은 JSONL에만 있다. text는 임베딩한 문장으로, 운영자가 정보 입력을 고친 사례를 찾는 데 쓴다. */
interface IndexRow {
  id: string;
  kind: ProductKind;
  text: string;
  vector: number[];
}

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** 색인 표의 벡터 길이 */
async function vectorLength(table: lancedb.Table): Promise<number> {
  const field = (await table.schema()).fields.find((f) => f.name === "vector");
  return (field?.type as { listSize?: number } | undefined)?.listSize ?? 0;
}

/**
 * JSONL 사례 기록(dir/cases.jsonl)과 LanceDB 임베딩 색인(dir/cases.lance). 사례 기록이 원본이고 색인은 거기서 만든다.
 * 검색할 때마다 색인을 기록에 맞춘다: 기록에서 빠진 사례(remove나 운영자가 줄을 지운 것)와 정보 입력을 고친 사례는 색인에서 지우고,
 * 색인에 없는 사례만 임베딩해 넣는다. 임베딩 모델을 바꿔 벡터 길이가 달라지면 색인을 기록 전체로 다시 만든다.
 */
export function lanceCaseStore({ dir, embed }: { dir: string; embed: Embed }): CaseStore {
  const file = join(dir, "cases.jsonl");
  /** 운영자가 줄을 직접 고칠 수 있으므로, 읽을 수 없는 줄은 그 줄 번호와 함께 알린다 */
  function read(): StoredCase[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8")
      .split("\n")
      .flatMap((line, i) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as StoredCase];
        } catch {
          throw new Error(`사례 기록(${file}) ${i + 1}번째 줄을 JSON으로 읽을 수 없습니다. 그 줄을 고치거나 지우세요`);
        }
      });
  }

  /** 색인을 사례 기록과 지금 임베딩 모델의 벡터 길이(length)에 맞춘 표. 사례가 하나도 없으면 null이다. */
  async function synced(cases: StoredCase[], length: number): Promise<lancedb.Table | null> {
    const db = await lancedb.connect(join(dir, "cases.lance"));
    let table = (await db.tableNames()).includes("cases") ? await db.openTable("cases") : null;
    if (table && (await vectorLength(table)) !== length) {
      await db.dropTable("cases");
      table = null;
    }
    const texts = new Map(cases.map((c) => [c.id, caseQuery(c.intake)]));
    const rows = table ? await table.query().select(["id", "text"]).toArray() : [];
    const stale = rows.filter((row) => texts.get(row.id) !== row.text).map((row) => row.id as string);
    if (table && stale.length > 0) await table.delete(`id IN (${stale.map(quoted).join(", ")})`);
    const indexed = new Set(rows.map((row) => row.id as string).filter((id) => !stale.includes(id)));
    const missing = cases.filter((c) => !indexed.has(c.id));
    if (missing.length === 0) return table;
    const vectors = await embed(missing.map((c) => texts.get(c.id)!));
    const added: IndexRow[] = missing.map((c, i) => ({ id: c.id, kind: c.kind, text: texts.get(c.id)!, vector: vectors[i] }));
    // LanceDB 표는 첫 줄로 열 형식을 정하므로 처음 넣을 때 만든다
    if (!table) return db.createTable("cases", added as unknown as Record<string, unknown>[]);
    await table.add(added as unknown as Record<string, unknown>[]);
    return table;
  }

  return {
    record: async (record) => {
      const id = randomUUID();
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify({ id, ...record })}\n`);
      return id;
    },
    similar: async (kind, query, limit) => {
      const cases = read();
      if (cases.length === 0) return [];
      const [vector] = await embed([query]);
      const table = await synced(cases, vector.length);
      if (!table) return [];
      const rows = await table.vectorSearch(vector).distanceType("cosine").where(`kind = ${quoted(kind)}`).limit(limit).toArray();
      // 색인은 방금 사례 기록에 맞췄으므로 찾은 id는 모두 기록에 있다
      const byId = new Map(cases.map((c) => [c.id, c]));
      return rows.map((row) => recordOf(byId.get(row.id as string)!));
    },
    list: async () => read(),
    remove: async (id) => {
      const kept = read().filter((c) => c.id !== id);
      writeFileSync(file, kept.map((c) => `${JSON.stringify(c)}\n`).join(""));
    },
  };
}

/** 글자 두 개 묶음을 해시한 벡터 길이 */
const NGRAM_DIMENSIONS = 256;

/** 외부 모델 없이 쓰는 임베딩: 글자 두 개 묶음의 해시 빈도. 글자가 많이 겹치는 문장끼리 가깝다. 시험과 개발용이다. */
export const ngramEmbedding: Embed = async (texts) =>
  texts.map((text) => {
    const vector = new Array<number>(NGRAM_DIMENSIONS).fill(0);
    const chars = [...text.replace(/\s+/g, " ")];
    for (let i = 0; i + 1 < chars.length; i++) {
      let hash = 0;
      for (const ch of chars[i] + chars[i + 1]) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
      vector[hash % NGRAM_DIMENSIONS]++;
    }
    return vector;
  });
