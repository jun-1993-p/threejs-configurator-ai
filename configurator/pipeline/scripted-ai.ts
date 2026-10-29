// 각본대로 답하는 가짜 AI 모델 포트. 단계마다 정해 둔 답을 차례로 내고, 받은 입력을 남긴다.
import type { AiPort } from "./runner.ts";

const STAGES = ["candidates", "style", "spec"] as const;
type ScriptStage = (typeof STAGES)[number];

/** 단계별 답 목록. 같은 단계가 다시 불리면 다음 답을 낸다. */
export type Script = Record<ScriptStage, unknown[]>;

export interface ScriptedAi extends AiPort {
  /** 단계별로 받은 입력, 불린 순서대로 */
  calls: Script;
}

export function scriptedAi(script: Script): ScriptedAi {
  const byStage = <T>(make: (stage: ScriptStage) => T) =>
    Object.fromEntries(STAGES.map((stage) => [stage, make(stage)])) as Record<ScriptStage, T>;
  const remaining = byStage((stage) => [...script[stage]]);
  const calls = byStage((): unknown[] => []);
  const answer = (stage: ScriptStage, input: unknown) => {
    calls[stage].push(input);
    if (remaining[stage].length === 0) return Promise.reject(new Error(`각본에 남은 ${stage} 답이 없습니다`));
    return Promise.resolve(structuredClone(remaining[stage].shift()));
  };
  return {
    calls,
    proposeCandidates: (input) => answer("candidates", input),
    chooseStyle: (input) => answer("style", input),
    writeSpec: (input) => answer("spec", input),
  };
}
