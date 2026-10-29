// 실제 모델로 파이프라인 돌려 보기(수동 확인용): LiteLLM을 거친 모델이 후보·스타일·명세를 쓰고, 운영자 대신 고르고 바로 승인한다.
// 추가 샘플을 받을 애드인 연결이 없으므로, 교차 검증이 필요 없는 슬라이더 하나짜리 후보 중 첫 번째를 고른다.
// 실행: node scripts/run-pipeline.ts <업로드 묶음.json> <정보 입력.json> <치수 규칙.json> <출력 폴더>
// 환경 변수: LITELLM_URL(기본 http://localhost:4000), LITELLM_API_KEY, LITELLM_MODEL(단계 공통 model_name, 기본 llm)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { liteLlmAi } from "../pipeline/litellm-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
import { runPipeline, type FusionPort, type HumanPort, type Intake, type PipelineResult } from "../pipeline/runner.ts";
import type { DimensionRule } from "../pipeline/range-intersection.ts";

const noAddin: FusionPort = {
  requestSamples: () => Promise.reject(new Error("이 도구는 애드인에 추가 샘플을 요청할 수 없습니다")),
  reconnected: () => Promise.reject(new Error("이 도구는 애드인 연결을 기다리지 않습니다")),
};

const singleSliderAndApprove: HumanPort = {
  chooseCandidate: async (candidates) => {
    const single = candidates.find((c) => c.parents.length === 1);
    if (!single) throw new Error(`슬라이더 하나짜리 후보가 없습니다: ${candidates.map((c) => `${c.id}(${c.parents.join("·")})`).join(", ")}`);
    return { candidate: single.id };
  },
  finalApproval: async () => ({ decision: "approve" }),
};

/** 파이프라인을 돌리고 처리 기록과 제출된 결과물을 outDir에 쓴다 */
export async function runWithLiteLlm(bundle: unknown, intake: Intake, rules: DimensionRule[], outDir: string): Promise<PipelineResult> {
  const model = process.env.LITELLM_MODEL ?? "llm";
  const ai = liteLlmAi({
    baseUrl: process.env.LITELLM_URL ?? "http://localhost:4000",
    apiKey: process.env.LITELLM_API_KEY,
    models: { candidates: model, style: model, spec: model },
  });
  const store = memoryStore({
    styles: [{ id: "natural" }, { id: "dark" }],
    rules,
    onLog: (entry) => console.log(`[${entry.stage}]`, entry.detail === undefined ? "" : JSON.stringify(entry.detail)),
  });
  const result = await runPipeline({ bundle, intake, human: singleSliderAndApprove, ports: { fusion: noAddin, ai, store } });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "log.json"), JSON.stringify(store.log, null, 2));
  for (const { files } of store.submissions) for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  return result;
}

if (import.meta.main) {
  const [bundlePath, intakePath, rulesPath, outDir] = process.argv.slice(2);
  if (!bundlePath || !intakePath || !rulesPath || !outDir) {
    console.error("사용법: node scripts/run-pipeline.ts <업로드 묶음.json> <정보 입력.json> <치수 규칙.json> <출력 폴더>");
    process.exit(2);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
  console.log(JSON.stringify(await runWithLiteLlm(read(bundlePath), read(intakePath), read(rulesPath), outDir)));
}
