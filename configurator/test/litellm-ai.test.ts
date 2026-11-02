// 경계 1에서 AI 모델 포트만 LiteLLM 구현으로 바꾼다. LiteLLM 프록시 자리에는 OpenAI 호환 채팅 API를 흉내 내는
// 가짜 HTTP 서버를 띄워, 단계별로 정해 둔 답(모델이 낸 문장)을 차례로 내고 받은 요청을 남긴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Spec } from "../src/engine.ts";
import { liteLlmAi } from "../pipeline/litellm-ai.ts";
import { memoryStore } from "../pipeline/memory-store.ts";
import { UI_STYLES } from "../pipeline/ui-styles.ts";
import type { DimensionRule } from "../pipeline/range-intersection.ts";
import { runPipeline, type Candidate, type FusionPort, type HumanPort, type Intake, type PartsFound } from "../pipeline/runner.ts";

const fixtures = new URL("../../fixtures/synthetic/", import.meta.url);
const bundle = JSON.parse(readFileSync(new URL("drawer.json", fixtures), "utf-8"));
const spec: Spec = JSON.parse(readFileSync(new URL("drawer.spec.json", fixtures), "utf-8"));

const intake: Intake = { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~900, 높이는 고정", thickness: "ai" };
const rules: DimensionRule[] = [{ id: "치수규칙/서랍장/폭", kind: "서랍장", part: "폭", axis: "W", min: 300, max: 1200, origin: "시험용" }];
const candidates: Candidate[] = [
  { id: "c1", front: "-Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 -Y" },
  { id: "c2", front: "+Y", sliders: [{ parameter: "body_w", name: "전체 폭" }], showThickness: false, summary: "전체 폭 하나", diff: "정면 +Y" },
];
const parts: PartsFound = { parts: [{ name: "DrawerBox", role: "서랍" }], fronts: ["-Y", "+Y"], up: "+Z" };
const styles = UI_STYLES;

const MODELS = { parts: "vlm-parts", candidates: "llm-candidates", style: "llm-style", spec: "llm-spec" };

const offline: FusionPort = {
  requestSamples: () => Promise.reject(new Error("이 시험에서는 추가 샘플을 요청하지 않는다")),
  reconnected: () => Promise.reject(new Error("이 시험에서는 연결을 기다리지 않는다")),
};

const approveFirst: HumanPort = {
  chooseCandidate: () => Promise.resolve({ candidate: "c1" }),
  finalApproval: () => Promise.resolve({ decision: "approve" }),
};

interface ChatRequest {
  path: string;
  authorization: string | undefined;
  body: { model: string; messages: { role: string; content: Content }[] };
}

/** 문장 하나, 또는 VLM에 보내는 문장·그림 조각 목록(OpenAI 호환 형식) */
type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

/** 사용자 메시지의 문장 부분 */
const textOf = (content: Content) => (typeof content === "string" ? content : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""));

/** 모델 이름별 답 목록을 차례로 내는 가짜 LiteLLM 프록시 */
async function fakeLiteLlm(answers: Record<string, string[]>) {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      const content = answers[body.model]?.shift();
      if (content === undefined) {
        res.writeHead(500).end(JSON.stringify({ error: { message: `${body.model}에 남은 답이 없습니다` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** 그 모델에 보낸 요청의 사용자 메시지(JSON) */
    inputs: (model: string) =>
      requests.filter((r) => r.body.model === model).map((r) => JSON.parse(textOf(r.body.messages.find((m) => m.role === "user")!.content))),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function run(answers: Partial<Record<keyof typeof MODELS, string[]>>) {
  const llm = await fakeLiteLlm({
    [MODELS.parts]: answers.parts ?? [JSON.stringify(parts)],
    [MODELS.candidates]: answers.candidates ?? [JSON.stringify(candidates)],
    [MODELS.style]: answers.style ?? [JSON.stringify({ style: "natural" })],
    [MODELS.spec]: answers.spec ?? [JSON.stringify(spec)],
  });
  const store = memoryStore({ styles, rules });
  const ai = liteLlmAi({ baseUrl: llm.baseUrl, apiKey: "sk-test", models: MODELS });
  try {
    const result = await runPipeline({ bundle, intake, human: approveFirst, ports: { fusion: offline, ai, store } });
    return { result, store, llm };
  } finally {
    await llm.close();
  }
}

test("LiteLLM을 거친 모델의 답으로 업로드부터 제출까지 진행한다", async () => {
  const { result, store, llm } = await run({});

  assert.equal(result.status, "submitted");
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
  assert.deepEqual(
    llm.requests.map((r) => [r.path, r.body.model, r.authorization]),
    [
      ["/v1/chat/completions", MODELS.parts, "Bearer sk-test"],
      ["/v1/chat/completions", MODELS.candidates, "Bearer sk-test"],
      ["/v1/chat/completions", MODELS.style, "Bearer sk-test"],
      ["/v1/chat/completions", MODELS.spec, "Bearer sk-test"],
    ],
  );
});

test("명세 작성 요청에는 정보 입력·고른 후보·치수 규칙과, 격자 점을 뺀 업로드 묶음 요약이 담긴다", async () => {
  const { llm } = await run({});

  const [request] = llm.requests.filter((r) => r.body.model === MODELS.spec);
  // 업로드 묶음은 4MB지만 모델에는 파라미터·부품·스윕 범위만 간다
  assert.ok(JSON.stringify(request.body).length < 20_000);
  const [input] = llm.inputs(MODELS.spec);
  assert.deepEqual(input.intake, intake);
  // 고른 후보에는 슬라이더마다 움직일 부모가 붙는다
  assert.deepEqual(input.candidate, { ...candidates[0], axes: { W: "X", D: "Y", H: "Z" }, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] });
  assert.deepEqual(input.rules, rules);
  assert.deepEqual(input.feedback, []);
  assert.deepEqual(input.schemaErrors, []);
  assert.deepEqual(
    input.bundle.parameters.find((p: { name: string }) => p.name === "drawer_d"),
    { name: "drawer_d", value: 430, unit: "mm", expression: "body_d - 20 mm", is_user: true, is_count: false },
  );
  // 전체 폭 600을 300~900으로 스윕하면 몸통과 서랍의 X 치수가 가장 크게 300 mm 바뀐다(단독 스윕의 축 반응)
  const unchanged = { X: 0, Y: 0, Z: 0 };
  assert.deepEqual(input.bundle.sweeps.find((s: { parameter: string }) => s.parameter === "body_w"), {
    parameter: "body_w",
    range: { min: 300, max: 900 },
    response: {
      overall: { X: 300, Y: 0, Z: 0 },
      parts: [
        { part: "Carcass", size: { X: 300, Y: 0, Z: 0 }, move: unchanged },
        { part: "DrawerBox", size: { X: 300, Y: 0, Z: 0 }, move: unchanged },
      ],
    },
  });
  // 부품마다 기본 형상의 바운딩 박스(Fusion 좌표, mm). 서랍장 몸통은 폭 600·깊이 450·높이 700이다.
  const carcass = input.bundle.parts.find((p: { name: string }) => p.name === "Carcass");
  assert.deepEqual(carcass.size, [600, 450, 700]);
  // 출력 형식은 명세 JSON Schema로 알려 준다
  const system = request.body.messages.find((m) => m.role === "system")!.content as string;
  assert.match(system, /"affects"/);
  // 모델이 $ref를 값으로 옮겨 적지 않도록 참조는 풀어서 보낸다
  assert.match(system, /"W":\{"enum":\["X","Y","Z"\]\}/);
  assert.doesNotMatch(system, /\$ref|\$defs/);
});

test("부품 탐색은 VLM 모델에 여섯 방향 그림을 PNG로 싣고, 그 결과가 후보 제시 요청에 담긴다", async () => {
  const { llm } = await run({});

  const [request] = llm.requests.filter((r) => r.body.model === MODELS.parts);
  const content = request.body.messages.find((m) => m.role === "user")!.content as Exclude<Content, string>;
  const images = content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : []));
  assert.equal(images.length, 6);
  assert.ok(images.every((url) => url.startsWith("data:image/png;base64,iVBORw0KGgo")));
  // 문장에는 그림 순서대로 어느 쪽에서 본 그림인지와 부품 색이 담기고, 그림 데이터는 다시 싣지 않는다
  const [input] = llm.inputs(MODELS.parts);
  assert.deepEqual(input.views, ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
  assert.deepEqual(input.colors.map((c: { name: string }) => c.name), ["Carcass", "DrawerBox"]);
  assert.ok(textOf(content).length < 5_000);
  assert.match(request.body.messages.find((m) => m.role === "system")!.content as string, /"fronts"/);
  assert.deepEqual(llm.inputs(MODELS.candidates)[0].parts, parts);
});

test("이름이 뜻을 말하지 않는 파라미터는 단독 스윕의 축 반응을 후보 제시 요청에 실어 슬라이더 이름을 짓게 한다", async () => {
  const { llm } = await run({});

  const [input] = llm.inputs(MODELS.candidates);
  // d6(수식 "200")을 100~300으로 스윕하면 서랍의 Z 치수만 바뀐다: 서랍 높이다
  assert.deepEqual(input.bundle.sweeps.find((s: { parameter: string }) => s.parameter === "d6").response, {
    overall: { X: 0, Y: 0, Z: 0 },
    parts: [
      { part: "Carcass", size: { X: 0, Y: 0, Z: 0 }, move: { X: 0, Y: 0, Z: 0 } },
      { part: "DrawerBox", size: { X: 0, Y: 0, Z: 100 }, move: { X: 0, Y: 0, Z: 50 } },
    ],
  });
  const [request] = llm.requests.filter((r) => r.body.model === MODELS.candidates);
  assert.match(request.body.messages.find((m) => m.role === "system")!.content as string, /Fusion 파라미터 이름이 아니라 고객이 보는 치수의 뜻/);
});

test("JSON으로 읽을 수 없는 답은 조립으로 가지 않고, 형식 오류와 그 답을 붙여 다시 묻는다", async () => {
  const broken = `명세입니다: ${JSON.stringify(spec).slice(0, 80)}`;
  const { result, store, llm } = await run({ spec: [broken, JSON.stringify(spec)] });

  assert.equal(result.status, "submitted");
  assert.deepEqual(
    store.log.map((e) => e.stage).filter((stage) => ["spec", "assembly", "verification"].includes(stage)),
    ["spec", "spec", "assembly", "verification"],
  );
  const [first, second] = llm.inputs(MODELS.spec);
  assert.equal(first.rejected, null);
  assert.equal(second.rejected, broken);
  assert.deepEqual(second.schemaErrors, ["(최상위): JSON으로 읽을 수 없는 답입니다. 설명 없이 JSON 하나만 내세요"]);
});

test("검증 피드백을 받으면 그 피드백을 받은 명세와 path를 붙여 다시 쓰게 하고, 고친 명세로 제출한다", async () => {
  // 서랍 몸통(DrawerBox)도 폭이 바뀌는데 형태 변경 부품에서 빠뜨린 명세
  const missing: Spec = { ...spec, sliders: [{ ...spec.sliders[0], affects: { shape: ["Carcass"], move: [] } }] };
  const { result, store, llm } = await run({ spec: [JSON.stringify(missing), JSON.stringify(spec)] });

  assert.equal(result.status, "submitted");
  const [, second] = llm.inputs(MODELS.spec);
  assert.deepEqual(second.previous, missing);
  assert.equal(second.rejected, null);
  assert.deepEqual(
    second.feedback.map((f: { path: string; part: string; kind: string }) => [f.path, f.part, f.kind]),
    [["sliders[0].affects.shape", "DrawerBox", "unexpected_shape_change"]],
  );
  assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
});

test("피드백을 받은 명세를 고치다 형식 오류가 나도, 다시 물을 때 피드백을 받은 명세가 그대로 간다", async () => {
  const missing: Spec = { ...spec, sliders: [{ ...spec.sliders[0], affects: { shape: ["Carcass"], move: [] } }] };
  const { result, llm } = await run({ spec: [JSON.stringify(missing), "고친 명세입니다", JSON.stringify(spec)] });

  assert.equal(result.status, "submitted");
  const [, second, third] = llm.inputs(MODELS.spec);
  assert.deepEqual(second.previous, missing);
  assert.deepEqual(third.previous, missing);
  assert.equal(third.rejected, "고친 명세입니다");
  assert.deepEqual(third.feedback, second.feedback);
});

test("LiteLLM 주소에 경로가 붙어 있어도 그 아래의 채팅 API를 부른다", async () => {
  const llm = await fakeLiteLlm({ [MODELS.style]: [JSON.stringify({ style: "natural" })] });
  try {
    const ai = liteLlmAi({ baseUrl: `${llm.baseUrl}/litellm`, models: MODELS });
    const candidate = { ...candidates[0], axes: { W: "X", D: "Y", H: "Z" } as const, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] };
    await ai.chooseStyle({ intake, candidate, styles, rejected: null, schemaErrors: [] });
    assert.deepEqual(llm.requests.map((r) => [r.path, r.authorization]), [["/litellm/v1/chat/completions", undefined]]);
  } finally {
    await llm.close();
  }
});

test("코드 블록으로 감싼 JSON 답도 읽는다", async () => {
  const { result, llm } = await run({ spec: ["```json\n" + JSON.stringify(spec, null, 2) + "\n```"] });

  assert.equal(result.status, "submitted");
  assert.equal(llm.inputs(MODELS.spec).length, 1);
});

test("LiteLLM이 오류로 답하면 그 상태와 이유를 담아 실패한다", async () => {
  // 명세 작성 모델에 남은 답이 없으면 가짜 프록시가 500으로 답한다
  await assert.rejects(run({ spec: [] }), /LiteLLM.*500.*llm-spec에 남은 답이 없습니다/);
});
