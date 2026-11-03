// 최종 확인 실행 도구(사용자 스토리 83~85): 개발 뒤 처음 보는 상품을 하나씩 실제 파이프라인으로 돌려 기록하고, 다 돌리면 판정한다.
// 확인 폴더의 products.json이 상품 목록이고, 기록은 같은 폴더의 check.json(시작 때 고정 코어·변형 엔진), results.json(상품마다),
// interrupted.json(파이프라인 밖의 오류로 끊긴 실행)이다.
// 실행(저장소의 configurator 폴더에서, git이 필요해 Docker 밖에서 돈다):
//   node scripts/final-check.ts start <확인 폴더>
//   node scripts/final-check.ts run <확인 폴더> <상품 id>
//   node scripts/final-check.ts report <확인 폴더>
// 환경 변수: SERVER_URL(업로드 서버, 기본 http://localhost:8000), HUMAN_PORT(운영자 화면 포트, 기본 8100),
// 그 밖에 LiteLLM·사례 저장소 설정은 scripts/run-pipeline.ts와 같다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { browserHuman } from "../pipeline/browser-human.ts";
import { finalVerdict, judgeRun, unseenEvidence, type ProductOutcome, type ProductRecord, type Recording } from "../pipeline/final-check.ts";
import { httpFusion } from "../pipeline/http-fusion.ts";
import type { DimensionRule } from "../pipeline/range-intersection.ts";
import type { Intake } from "../pipeline/runner.ts";
import { checkIntake, type FailureClass, type VerdictStatus } from "../pipeline/schemas.ts";
import type { UploadBundle } from "../pipeline/upload-bundle.ts";
import { liteLlmStore, runWithLiteLlm } from "./run-pipeline.ts";

/** 최종 확인 상품 목록. rules는 확인 폴더 기준 치수 규칙 파일, upload는 애드인이 올린 서버의 업로드 id다. */
interface Manifest {
  rules: string;
  products: { id: string; upload: string; intake: Intake }[];
}

/** 최종 확인을 시작한 기록: 개발이 끝난 커밋과 그때의 고정 코어·변형 엔진 */
interface Started {
  at: string;
  commit: string;
  core: string;
}

/** LiteLLM·서버 오류처럼 파이프라인 밖에서 끊긴 실행. 판정에는 들지 않지만, 다시 돌린 상품이 보이도록 남긴다. */
interface Interruption {
  id: string;
  at: string;
  error: string;
}

/**
 * 도구가 닿는 바깥: 저장소 루트(git과 fixtures/), 업로드 서버, 운영자 화면을 여는 주소.
 * onHuman은 운영자 화면이 뜨면 그 주소로 불린다.
 */
export interface CheckEnv {
  root: string;
  serverUrl: string;
  human: { host: string; port: number; onHuman?: (url: string) => void };
}

/** 확인을 돌리지 않고 멈춘 까닭(이미 돌린 상품, 바뀐 고정 코어 등). 명령줄에서는 그 문장을 찍고 1로 끝난다. */
export class CheckRefused extends Error {}

const CLASS_NAMES: Record<FailureClass, string> = { spec: "명세 문제", engine: "엔진 한계" };
const STATUS_NAMES: Record<VerdictStatus, string> = { running: "진행 중", passed: "통과", failed: "불통과", invalid: "무효" };

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8"));
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readList = <T>(path: string): T[] => (existsSync(path) ? readJson(path) : []);

/** 확인 폴더 안의 파일 */
const filesOf = (dir: string) => ({
  manifest: join(dir, "products.json"),
  started: join(dir, "check.json"),
  records: join(dir, "results.json"),
  interruptions: join(dir, "interrupted.json"),
  report: join(dir, "report.md"),
});

function fail(message: string): never {
  throw new CheckRefused(message);
}

/** 고정 코어·변형 엔진(configurator/src)의 커밋된 트리. 커밋하지 않은 변경이 있으면 멈춘다. */
function coreTree(root: string): string {
  if (git(root, "status", "--porcelain", "--", "configurator/src") !== "") fail("configurator/src에 커밋하지 않은 변경이 있습니다. 고정 코어·변형 엔진을 고치지 않고 돌려야 합니다");
  return git(root, "rev-parse", "HEAD:configurator/src");
}

/** 개발 중 녹화본: fixtures/ 아래(합성 녹화본, fixtures/private/의 실물 녹화본)의 업로드 묶음 */
function devRecordings(root: string): Recording[] {
  const found: Recording[] = [];
  const fixtures = join(root, "fixtures");
  for (const name of readdirSync(fixtures, { recursive: true, encoding: "utf-8" })) {
    if (!name.endsWith(".json")) continue;
    const path = join(fixtures, name);
    const value = readJson<Partial<UploadBundle>>(path);
    // 교차 검증 샘플·명세 같은 다른 녹화 파일은 업로드 묶음이 아니다
    if (Array.isArray(value.parameters) && Array.isArray(value.parts)) found.push({ path: relative(root, path).replaceAll("\\", "/"), bundle: value as UploadBundle });
  }
  return found;
}

const outcomeText = (outcome: ProductOutcome) => (outcome.passed ? "통과" : `통과 못함(${CLASS_NAMES[outcome.failure!.class]})`);

export function start(dir: string, { root }: Pick<CheckEnv, "root">): void {
  const files = filesOf(dir);
  if (existsSync(files.started)) fail(`이미 시작한 최종 확인입니다: ${files.started}`);
  const manifest = readJson<Manifest>(files.manifest);
  for (const { id, intake } of manifest.products) {
    const errors = checkIntake(intake);
    if (errors.length > 0) fail(`${id}의 정보 입력 형식 오류: ${errors.join("; ")}`);
  }
  const started: Started = { at: new Date().toISOString(), commit: git(root, "rev-parse", "HEAD"), core: coreTree(root) };
  writeJson(files.started, started);
  console.log(`최종 확인을 시작합니다. 개발이 끝난 커밋 ${started.commit}, 고정 코어·변형 엔진 ${started.core}, 상품 ${manifest.products.length}개`);
}

export async function run(dir: string, id: string, { root, serverUrl, human: screen }: CheckEnv): Promise<void> {
  const files = filesOf(dir);
  if (!existsSync(files.started)) fail(`먼저 시작하세요: node scripts/final-check.ts start ${dir}`);
  const started = readJson<Started>(files.started);
  const manifest = readJson<Manifest>(files.manifest);
  const product = manifest.products.find((p) => p.id === id) ?? fail(`상품 목록에 없는 id입니다: ${id}`);
  const records = readList<ProductRecord>(files.records);
  // 같은 상품을 다시 돌려 통과할 때까지 고르지 않는다
  if (records.some((r) => r.id === id)) fail(`이미 돌린 상품입니다: ${id}`);
  const core = coreTree(root);
  if (core !== started.core) fail(`고정 코어·변형 엔진이 최종 확인을 시작할 때(${started.core})와 다릅니다(${core})`);

  const uploaded = await fetch(`${serverUrl}/uploads/${encodeURIComponent(product.upload)}`);
  if (!uploaded.ok) fail(`서버에서 업로드 묶음을 받지 못했습니다(업로드 ${product.upload}, ${uploaded.status})`);
  const bundle = (await uploaded.json()) as UploadBundle;
  const unseen = unseenEvidence(bundle, devRecordings(root));
  if (unseen.matches.length > 0) fail(`개발 중 녹화본과 같은 모델이라 최종 확인 상품이 될 수 없습니다(${id}): ${unseen.matches.join(", ")}`);

  const rules = readJson<DimensionRule[]>(join(dir, manifest.rules));
  // 최종 승인 화면은 AI 판정 렌더링을 저장소가 돌려준 경로로 가리킨다
  const store = liteLlmStore(rules);
  const human = await browserHuman({
    product: product.intake.name,
    assets: (path) => store.renders.find((r) => r.path === path)?.png,
    host: screen.host,
    port: screen.port,
  });
  console.log(`운영자 화면: http://<이 머신의 LAN 주소>:${new URL(human.url).port}/`);
  screen.onHuman?.(human.url);
  try {
    const fusion = httpFusion({ baseUrl: serverUrl, upload: product.upload });
    const { result, log } = await runWithLiteLlm(bundle, product.intake, rules, join(dir, id), { human, fusion, store });
    const record: ProductRecord = { id, at: new Date().toISOString(), core, unseen, result, outcome: judgeRun(log, result) };
    writeJson(files.records, [...records, record]);
    console.log(`${id}: ${outcomeText(record.outcome)}`);
  } catch (error) {
    const interruption: Interruption = { id, at: new Date().toISOString(), error: String(error) };
    writeJson(files.interruptions, [...readList<Interruption>(files.interruptions), interruption]);
    throw error;
  } finally {
    await human.close();
  }
}

/** 상품마다 결과와 사람 개입, 실패의 까닭을 report.md에 쓰고 판정을 찍는다 */
export function report(dir: string): void {
  const files = filesOf(dir);
  const started = readJson<Started>(files.started);
  const manifest = readJson<Manifest>(files.manifest);
  const records = readList<ProductRecord>(files.records);
  const interruptions = readList<Interruption>(files.interruptions);
  const verdict = finalVerdict({ products: manifest.products.map((p) => p.id), core: started.core, records });
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const lines = [
    "# 최종 확인 결과",
    "",
    `- 판정: ${STATUS_NAMES[verdict.status]} (${verdict.passed}/${verdict.total}개가 후보 선택과 최종 승인만으로 끝남)`,
    `- 개발이 끝난 커밋: ${started.commit}, 고정 코어·변형 엔진 트리: ${started.core} (시작 ${started.at})`,
    ...verdict.problems.map((p) => `- 무효 까닭: ${p}`),
    ...(verdict.missing.length > 0 ? [`- 돌리지 않은 상품: ${verdict.missing.join(", ")}`] : []),
    ...interruptions.map((i) => `- 끊긴 실행: ${i.id} (${i.at}) ${i.error}`),
    "",
    "| 상품 | 상품명 | 결과 | 사람 개입 | 까닭 | 처음 보는 상품 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...records.map(({ id, outcome, unseen }) => {
      const name = manifest.products.find((p) => p.id === id)?.intake.name ?? "";
      const evidence = outcome.failure?.evidence.join("; ") ?? "";
      const seen = unseen.matches.length === 0 ? `녹화본 ${unseen.compared}개와 겹치지 않음 (지문 ${unseen.fingerprint.slice(0, 12)})` : `겹침: ${unseen.matches.join(", ")}`;
      return `| ${id} | ${cell(name)} | ${outcomeText(outcome)} | ${cell(outcome.interventions.join("; "))} | ${cell(evidence)} | ${seen} |`;
    }),
    "",
  ];
  writeFileSync(files.report, lines.join("\n"));
  console.log(lines.join("\n"));
}

if (import.meta.main) {
  const [command, dir, id] = process.argv.slice(2);
  const env: CheckEnv = {
    root: fileURLToPath(new URL("../../", import.meta.url)),
    serverUrl: process.env.SERVER_URL ?? "http://localhost:8000",
    // 운영자가 LAN의 다른 기기에서도 열 수 있게 한다
    human: { host: "0.0.0.0", port: Number(process.env.HUMAN_PORT ?? 8100) },
  };
  try {
    if (command === "start" && dir) start(dir, env);
    else if (command === "run" && dir && id) await run(dir, id, env);
    else if (command === "report" && dir) report(dir);
    else {
      console.error("사용법: node scripts/final-check.ts start <확인 폴더> | run <확인 폴더> <상품 id> | report <확인 폴더>");
      process.exit(2);
    }
  } catch (error) {
    if (!(error instanceof CheckRefused)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
