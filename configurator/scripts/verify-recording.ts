// 실제 녹화본으로 검증 단계를 돌리는 도구(에이전트용): 녹화본에 손으로 쓴 명세를 붙여, AI 없이 실행기와 같은 검증 순서(pipeline/verify-spec.ts)를
// 돌린다. 추가 샘플은 서버를 거쳐 업로드한 애드인에 요청한다. 실패를 모으는 일이라 첫 실패 단계에서 멈추지 않는다.
// 실행(저장소의 configurator 폴더에서):
//   node scripts/verify-recording.ts <녹화본.json> <명세.json> --upload <업로드 ID>   검증 단계마다 피드백을 한 줄씩 찍는다
//   node scripts/verify-recording.ts <녹화본.json> --responses                       슬라이더별 부품 반응(명세의 affects를 정하는 근거)
// 환경 변수: SERVER_URL(업로드 서버, 기본 http://localhost:8000)
// 끝 코드: 0 모두 통과, 1 검증 실패나 애드인이 샘플을 못 뽑음, 2 입력 오류, 3 Fusion 연결 필요
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Spec } from "../src/engine.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { httpFusion } from "../pipeline/http-fusion.ts";
import { sweepResponse } from "../pipeline/parameter-relations.ts";
import { FUSION_NEEDED, type FusionPort } from "../pipeline/runner.ts";
import { checkSpec, checkUploadBundle, FUSION_AXES, specReferenceChecker } from "../pipeline/schemas.ts";
import { UI_STYLES } from "../pipeline/ui-styles.ts";
import type { UploadBundle } from "../pipeline/upload-bundle.ts";
import { sampleRequester, samplesFailed, verifySpec, type StageResult, type VerifyStage } from "../pipeline/verify-spec.ts";

export interface ToolEnv {
  /** 업로드 ID로 Fusion 연결을 만든다 */
  fusion: (upload: string) => FusionPort;
  print: (line: string) => void;
  /** 애드인이 추가 샘플에 답하는 상태 파일(티켓 33). 연결이 끊겼을 때 있으면 그 내용을 찍는다. */
  servingFile: string;
}

/** 단계 이름(GLOSSARY 용어) */
const STAGE_NAMES: Record<VerifyStage, string> = {
  thickness_samples: "두께 후보 형상",
  range: "스윕 범위",
  thickness_fixed: "두께 고정 실측",
  numeric: "수치 검증",
  axis: "축 반응",
  cross: "교차 검증",
  grid_checks: "격자 검증점",
  grid_reinforcement: "격자 보강",
};

const USAGE = "사용법: node scripts/verify-recording.ts <녹화본.json> <명세.json> --upload <업로드 ID> | <녹화본.json> --responses";

/** 애드인이 끊겨 있어 더 볼 수 없음 */
class FusionNeeded extends Error {}
/** 애드인이 샘플을 뽑지 못했거나 응답이 형식에 맞지 않음 */
class SampleFailed extends Error {}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));

const feedbackLine = (f: Feedback) => `슬라이더 ${f.slider || "-"} · 부품 ${f.part || "-"} · ${f.kind} · 잰 값 ${JSON.stringify(f.measured)}`;

/** 슬라이더(스윕한 파라미터)마다 상품 전체와 부품의 치수·위치 변화를 축별로 찍는다. 0인 축과 바뀌지 않은 부품은 뺀다. */
function printResponses(bundle: UploadBundle, print: (line: string) => void): void {
  const axes = (values: Record<string, number>) =>
    FUSION_AXES.filter((a) => values[a] !== 0)
      .map((a) => `${a} ${values[a]}`)
      .join(" ");
  for (const { parameter } of bundle.sweeps) {
    const response = sweepResponse(bundle, parameter)!;
    print(`${parameter}: 전체 치수 ${axes(response.overall) || "변화 없음"}`);
    for (const { part, size, move } of response.parts) {
      const [s, m] = [axes(size), axes(move)];
      if (s || m) print(`  ${part}: 치수 ${s || "-"} / 위치 ${m || "-"}`);
    }
  }
}

/** 단계 결과를 찍는다: 통과면 한 줄, 아니면 피드백마다 한 줄 */
function printStage({ stage, reinforced, feedback }: StageResult, print: (line: string) => void): void {
  const label = `[${reinforced ? "격자 보강 뒤 " : ""}${STAGE_NAMES[stage]}]`;
  if (feedback.length === 0) print(`${label} 통과`);
  for (const f of feedback) print(`${label} ${feedbackLine(f)}`);
}

async function verify(bundle: UploadBundle, spec: Spec, fusion: FusionPort, env: ToolEnv): Promise<number> {
  // 연결이 끊겼으면 다시 연결되기를 기다리지 않고 끝낸다
  const requestSamples = sampleRequester(
    async (request) => {
      const answer = await fusion.requestSamples(request);
      if (answer.status === "disconnected") throw new FusionNeeded();
      if (answer.status === "failed") throw new SampleFailed(samplesFailed(answer.reason));
      return answer.response;
    },
    (reason) => new SampleFailed(reason),
  );
  try {
    // 실패한 쌍을 피드백으로 고치기 전에 격자로 고쳐지는지까지 본다. 단계마다 바로 찍어, 뒤에서 끝나도 앞 단계 결과가 남는다.
    const { feedback } = await verifySpec({
      spec,
      bundle,
      style: UI_STYLES[0],
      reinforcements: [],
      requestSamples,
      shouldReinforce: () => true,
      keepGoing: true,
      onStage: (result) => printStage(result, env.print),
    });
    return feedback.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof SampleFailed) {
      env.print(error.message);
      return 1;
    }
    if (!(error instanceof FusionNeeded)) throw error;
    // 업로드 완료 창이 열려 있으면 애드인이 서버를 찾지 못한다. 상태 파일이 있으면 까닭을 가리도록 함께 찍는다.
    if (existsSync(env.servingFile)) env.print(`애드인 상태(${env.servingFile}): ${readFileSync(env.servingFile, "utf-8").trim()}`);
    env.print(FUSION_NEEDED);
    return 3;
  }
}

/** 명령줄 인자로 도구를 돌리고 끝 코드를 돌려준다 */
export async function main(args: string[], env: ToolEnv): Promise<number> {
  const responses = args.includes("--responses");
  const at = args.indexOf("--upload");
  const upload = at >= 0 ? args[at + 1] : undefined;
  const paths = args.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!(responses ? paths.length === 1 : paths.length === 2 && upload)) {
    env.print(USAGE);
    return 2;
  }
  const raw = readJson(paths[0]);
  const bundleErrors = checkUploadBundle(raw);
  if (bundleErrors.length > 0) {
    env.print(`녹화본 형식 오류: ${bundleErrors.join("; ")}`);
    return 2;
  }
  const bundle = raw as UploadBundle;
  if (responses) {
    printResponses(bundle, env.print);
    return 0;
  }
  const spec = readJson(paths[1]);
  const specErrors = checkSpec(spec);
  if (specErrors.length === 0) specErrors.push(...specReferenceChecker(bundle)(spec as Spec));
  if (specErrors.length > 0) {
    env.print(`명세 오류: ${specErrors.join("; ")}`);
    return 2;
  }
  return verify(bundle, spec as Spec, env.fusion(upload!), env);
}

if (import.meta.main) {
  const serverUrl = process.env.SERVER_URL ?? "http://localhost:8000";
  process.exitCode = await main(process.argv.slice(2), {
    fusion: (upload) => httpFusion({ baseUrl: serverUrl, upload }),
    print: (line) => console.log(line),
    servingFile: fileURLToPath(new URL("../../data/addin-checks/serving.json", import.meta.url)),
  });
}
