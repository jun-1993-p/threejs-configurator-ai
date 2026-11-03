// 최종 확인 실행 도구: 임시 git 저장소(고정 코어·변형 엔진과 개발 중 녹화본), 업로드 서버와 LiteLLM 자리의 가짜 HTTP 서버,
// 운영자 화면에 양식을 보내는 손으로 start → run → report를 돌린다. 판정을 무효로 만들지 않게 막는 거부 규칙을 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProductRecord } from "../pipeline/final-check.ts";
import type { Candidate, PartsFound } from "../pipeline/runner.ts";
import { report, run, start, type CheckEnv } from "../scripts/final-check.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const drawer = readFileSync(new URL("drawer.json", fixtures), "utf-8");
const spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

/** 처음 보는 상품: 서랍장 녹화본에 슬라이더로 쓰지 않는 파라미터를 하나 더해 모델 지문을 바꿨다 */
const unseenBundle = { ...JSON.parse(drawer), parameters: [...JSON.parse(drawer).parameters, { name: "새_파라미터", value: 1, unit: "", expression: "1", is_user: false, is_count: false }] };

const parts: PartsFound = { parts: [{ name: "DrawerBox", role: "서랍" }], fronts: ["-Y", "+Y"], up: "+Z" };
const candidates: Candidate[] = [
  { id: "c1", front: "-Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" },
  { id: "c2", front: "+Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 +Y" },
];

/** 고정 코어·변형 엔진(configurator/src)과 개발 중 녹화본(fixtures/)을 커밋한 임시 저장소 */
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "final-check-"));
  mkdirSync(join(root, "configurator", "src"), { recursive: true });
  mkdirSync(join(root, "fixtures", "synthetic"), { recursive: true });
  writeFileSync(join(root, "configurator", "src", "engine.ts"), "export const engine = 1;\n");
  writeFileSync(join(root, "fixtures", "synthetic", "drawer.json"), drawer);
  // 교차 검증 샘플처럼 업로드 묶음이 아닌 녹화 파일은 견주지 않는다
  writeFileSync(join(root, "fixtures", "synthetic", "drawer.spec.json"), JSON.stringify(spec));
  commit(root, "개발 끝");
  return root;
}

function commit(root: string, message: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  if (!existsSync(join(root, ".git"))) git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
}

/** 상품 두 개짜리 확인 폴더. p1은 처음 보는 상품, p2는 개발 중 녹화본을 다시 올린 것이다. */
function checkDir(root: string): string {
  const dir = join(root, "check");
  mkdirSync(dir);
  writeFileSync(join(dir, "rules.json"), JSON.stringify([{ id: "치수규칙/서랍장/폭", kind: "서랍장", part: "폭", axis: "W", min: 300, max: 1200, origin: "시험용" }]));
  const intake = { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~900", thickness: "ai" };
  writeFileSync(join(dir, "products.json"), JSON.stringify({ rules: "rules.json", products: [{ id: "p1", upload: "u1", intake }, { id: "p2", upload: "u2", intake }] }));
  return dir;
}

/** JSON으로 답하는 가짜 HTTP 서버 */
async function jsonServer(answer: (method: string, url: string, body: string) => { status: number; body?: unknown }) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { status, body } = answer(req.method ?? "", req.url ?? "", raw);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? null));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** 업로드 서버: 업로드 id마다 묶음을 돌려준다. 슬라이더 하나짜리 명세라 추가 샘플 요청은 오지 않는다. */
const uploadServer = () =>
  jsonServer((_, url) => {
    const bundle = { "/uploads/u1": unseenBundle, "/uploads/u2": JSON.parse(drawer) }[url];
    return bundle ? { status: 200, body: bundle } : { status: 404, body: { detail: "업로드 묶음이 없습니다" } };
  });

/** LiteLLM 자리: 단계별 답을 차례로 낸다. broken이면 모든 호출에 500으로 답한다(외부 API가 막힌 경우). */
function fakeLiteLlm(broken = false) {
  const answers: Record<string, unknown[]> = { vlm: [parts, { problems: [] }], llm: [candidates, { style: "natural" }, spec] };
  return jsonServer((_, url, raw) => {
    if (broken) return { status: 500, body: { error: { message: "모든 모델이 답하지 않았습니다" } } };
    const body = JSON.parse(raw);
    if (url.endsWith("/embeddings")) {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      return { status: 200, body: { data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) } };
    }
    const content = JSON.stringify(answers[body.model].shift());
    return { status: 200, body: { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] } };
  });
}

/** 운영자의 손: 후보 선택 화면이면 c1을 고르고, 최종 승인 화면이면 슬라이더 이름만 고쳐 승인한다 */
function operatorHand() {
  let timer: NodeJS.Timeout | undefined;
  const slider = spec.sliders[0];
  const post = (url: string, form: Record<string, string>) => fetch(url, { method: "POST", body: new URLSearchParams(form) });
  return {
    onHuman: (url: string) => {
      timer = setInterval(async () => {
        // run이 끝나면 운영자 화면이 닫혀, 그 뒤에 보낸 요청은 실패한다
        try {
          const html = await (await fetch(url)).text();
          if (html.includes("후보 선택</h1>")) await post(url, { candidate: "c1" });
          else if (html.includes("최종 승인</h1>")) await post(url, { decision: "approve", [`name:${slider.id}`]: "가로 길이", [`min:${slider.id}`]: `${slider.min}`, [`max:${slider.id}`]: `${slider.max}` });
        } catch {}
      }, 20);
    },
    stop: () => clearInterval(timer),
  };
}

/** 가짜 서버들을 띄우고 도구가 닿는 바깥을 그쪽으로 돌린다 */
async function harness({ broken = false } = {}) {
  const root = tempRepo();
  const dir = checkDir(root);
  const uploads = await uploadServer();
  const llm = await fakeLiteLlm(broken);
  const hand = operatorHand();
  process.env.LITELLM_URL = llm.url;
  process.env.CASES_DIR = join(root, "cases");
  const env: CheckEnv = { root, serverUrl: uploads.url, human: { host: "127.0.0.1", port: 0, onHuman: hand.onHuman } };
  return {
    root,
    dir,
    env,
    close: async () => {
      hand.stop();
      await Promise.all([uploads.close(), llm.close()]);
    },
  };
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8"));

test("처음 보는 상품을 돌려 통과로 기록하고, 같은 상품은 다시 돌리지 않으며, 보고서에 진행 중 판정이 남는다", async () => {
  const { root, dir, env, close } = await harness();
  try {
    start(dir, env);
    await run(dir, "p1", env);

    const [record] = read<ProductRecord[]>(join(dir, "results.json"));
    assert.equal(record.id, "p1");
    assert.deepEqual(record.outcome, { passed: true, interventions: [], failure: null });
    assert.equal(record.core, execFileSync("git", ["rev-parse", "HEAD:configurator/src"], { cwd: root, encoding: "utf-8" }).trim());
    assert.deepEqual([record.unseen.compared, record.unseen.matches], [1, []]);
    await assert.rejects(run(dir, "p1", env), /이미 돌린 상품입니다: p1/);

    report(dir);
    const written = readFileSync(join(dir, "report.md"), "utf-8");
    assert.match(written, /판정: 진행 중 \(1\/2개/);
    assert.match(written, /돌리지 않은 상품: p2/);
    assert.match(written, /\| p1 \| 1단 서랍장 \| 통과 \|/);
  } finally {
    await close();
  }
});

test("개발 중 녹화본과 모델 지문이 같은 상품은 돌리지 않는다", async () => {
  const { dir, env, close } = await harness();
  try {
    start(dir, env);

    await assert.rejects(run(dir, "p2", env), /개발 중 녹화본과 같은 모델이라 최종 확인 상품이 될 수 없습니다\(p2\): fixtures\/synthetic\/drawer\.json$/);
    assert.equal(existsSync(join(dir, "results.json")), false);
  } finally {
    await close();
  }
});

test("고정 코어·변형 엔진을 시작 뒤에 고쳐 커밋했으면 돌리지 않고, 커밋하지 않은 변경이 있으면 시작하지 않는다", async () => {
  const { root, dir, env, close } = await harness();
  try {
    start(dir, env);
    writeFileSync(join(root, "configurator", "src", "engine.ts"), "export const engine = 2;\n");
    commit(root, "엔진 고침");
    await assert.rejects(run(dir, "p1", env), /고정 코어·변형 엔진이 최종 확인을 시작할 때\(.+\)와 다릅니다/);

    writeFileSync(join(root, "configurator", "src", "engine.ts"), "export const engine = 3;\n");
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    writeFileSync(join(fresh, "products.json"), readFileSync(join(dir, "products.json")));
    assert.throws(() => start(fresh, env), /configurator\/src에 커밋하지 않은 변경이 있습니다/);
  } finally {
    await close();
  }
});

test("파이프라인 밖의 오류로 끊긴 실행은 판정에 넣지 않고 끊긴 실행으로 남겨 보고서에 보인다", async () => {
  const { dir, env, close } = await harness({ broken: true });
  try {
    start(dir, env);

    await assert.rejects(run(dir, "p1", env));
    assert.equal(existsSync(join(dir, "results.json")), false);
    const [interruption] = read<{ id: string; error: string }[]>(join(dir, "interrupted.json"));
    assert.equal(interruption.id, "p1");
    report(dir);
    assert.match(readFileSync(join(dir, "report.md"), "utf-8"), /끊긴 실행: p1 /);
  } finally {
    await close();
  }
});
