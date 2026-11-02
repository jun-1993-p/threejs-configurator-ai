// 실제 모델로 파이프라인 돌려 보기(수동 확인용): LiteLLM을 거친 모델이 부품 탐색·후보·스타일·명세·AI 판정을 하고, 운영자 대신 고르고 바로 승인한다.
// 추가 샘플을 받을 애드인 연결이 없으므로, 교차 검증이 필요 없는 슬라이더 하나짜리 후보 중 첫 번째를 고른다. 자식 치수면 첫 부모 후보다.
// 실행: node scripts/run-pipeline.ts <업로드 묶음.json> <정보 입력.json> <치수 규칙.json> <출력 폴더>
// 환경 변수: LITELLM_URL(기본 http://localhost:4000), LITELLM_API_KEY, LITELLM_MODEL(LLM 단계 공통 model_name, 기본 llm),
// LITELLM_VLM_MODEL(부품 탐색·AI 판정 model_name, 기본 vlm)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { liteLlmAi } from "../pipeline/litellm-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
import { candidateCardsHtml, finalApprovalHtml } from "../pipeline/operator-screens.ts";
import { runPipeline, type FusionPort, type HumanPort, type Intake, type PipelineResult } from "../pipeline/runner.ts";
import type { DimensionRule } from "../pipeline/range-intersection.ts";
import { UI_STYLES } from "../pipeline/ui-styles.ts";

const noAddin: FusionPort = {
  requestSamples: () => Promise.reject(new Error("이 도구는 애드인에 추가 샘플을 요청할 수 없습니다")),
  reconnected: () => Promise.reject(new Error("이 도구는 애드인 연결을 기다리지 않습니다")),
};

/**
 * 후보 카드 화면을 outDir에 남기고(회차마다 candidates-1.html, -2.html …) 슬라이더 하나짜리 후보를 고른 뒤,
 * 최종 승인 화면을 approval.html로 남기고 바로 승인한다
 */
function singleSliderAndApprove(product: string, outDir: string): HumanPort {
  let round = 0;
  return {
    chooseCandidate: async (cards) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `candidates-${++round}.html`), candidateCardsHtml(product, cards));
      const single = cards.find((c) => c.sliders.length === 1);
      if (!single) throw new Error(`슬라이더 하나짜리 후보가 없습니다: ${cards.map((c) => `${c.id}(${c.sliders.map((s) => s.parameter).join("·")})`).join(", ")}`);
      return { candidate: single.id, parents: Object.fromEntries(single.choices.map((c) => [c.parameter, c.options[0].parent])) };
    },
    finalApproval: async (review) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "approval.html"), finalApprovalHtml(review));
      return { decision: "approve" };
    },
  };
}

/** 파이프라인을 돌리고 처리 기록, AI 판정이 문제를 찾은 렌더링(최종 승인 화면이 그 경로로 읽는다), 제출된 결과물을 outDir에 쓴다 */
export async function runWithLiteLlm(bundle: unknown, intake: Intake, rules: DimensionRule[], outDir: string): Promise<PipelineResult> {
  const model = process.env.LITELLM_MODEL ?? "llm";
  const vlm = process.env.LITELLM_VLM_MODEL ?? "vlm";
  const ai = liteLlmAi({
    baseUrl: process.env.LITELLM_URL ?? "http://localhost:4000",
    apiKey: process.env.LITELLM_API_KEY,
    models: { parts: vlm, candidates: model, style: model, spec: model, judgment: vlm },
  });
  const store = memoryStore({
    styles: UI_STYLES,
    rules,
    onLog: (entry) => console.log(`[${entry.stage}]`, entry.detail === undefined ? "" : JSON.stringify(entry.detail)),
  });
  const result = await runPipeline({ bundle, intake, human: singleSliderAndApprove(intake.name, outDir), ports: { fusion: noAddin, ai, store } });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "log.json"), JSON.stringify(store.log, null, 2));
  for (const { path, png } of store.renders) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), png);
  }
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
