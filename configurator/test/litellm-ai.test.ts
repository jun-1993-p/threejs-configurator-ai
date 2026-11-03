// 경계 1에서 AI 모델 포트만 LiteLLM 구현으로 바꾼다. LiteLLM 프록시 자리에는 OpenAI 호환 채팅 API를 흉내 내는
// 가짜 HTTP 서버를 띄워, 단계별로 정해 둔 답(모델이 낸 문장)을 차례로 내고 받은 요청을 남긴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Spec } from "../src/engine.ts";
import { liteLlmAi, liteLlmEmbed } from "../pipeline/litellm-ai.ts";
import { memoryCaseStore } from "../pipeline/case-store.ts";
import { decodePng } from "../pipeline/image-sheet.ts";
import { encodePng } from "../pipeline/render.ts";
import { pastCase } from "./cases.ts";
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

const MODELS = { parts: "vlm-parts", candidates: "llm-candidates", style: "llm-style", spec: "llm-spec", judgment: "vlm-judgment" };

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

/** 사용자 메시지에 붙은 그림(data URI) */
const imagesOf = (content: Content) => (typeof content === "string" ? [] : content.flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : [])));

/** PNG data URI의 너비·높이(IHDR) */
function pngSize(url: string): [number, number] {
  assert.ok(url.startsWith("data:image/png;base64,iVBORw0KGgo"));
  const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** 사용자 메시지의 문장 부분 */
const textOf = (content: Content) => (typeof content === "string" ? content : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""));

/**
 * 모델이 낸 답. 문장만 주면 그 문장이 content이고, 객체면 응답 메시지 그대로다.
 * 추론 모델은 추론을 content 밖의 필드나 content 앞의 <think> 블록에 싣는다.
 */
type Answer = string | { content: string | null; reasoning?: string; reasoning_content?: string };

/** 모델 이름별 답 목록을 차례로 내는 가짜 LiteLLM 프록시. delayMs만큼 늦게 답한다(예비 모델로 넘어가느라 늦는 프록시). */
async function fakeLiteLlm(answers: Record<string, Answer[]>, { delayMs = 0 } = {}) {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = JSON.parse(raw);
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const answer = answers[body.model]?.shift();
      if (answer === undefined) {
        res.writeHead(500).end(JSON.stringify({ error: { message: `${body.model}에 남은 답이 없습니다` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const message = { role: "assistant", ...(typeof answer === "string" ? { content: answer } : answer) };
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }));
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
    // 늦게 답하는 중에 끊은 연결이 남아 있어도 닫는다
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function run(answers: Partial<Record<keyof typeof MODELS, Answer[]>>, cases = memoryCaseStore()) {
  const llm = await fakeLiteLlm({
    [MODELS.parts]: answers.parts ?? [JSON.stringify(parts)],
    [MODELS.candidates]: answers.candidates ?? [JSON.stringify(candidates)],
    [MODELS.style]: answers.style ?? [JSON.stringify({ style: "natural" })],
    [MODELS.spec]: answers.spec ?? [JSON.stringify(spec)],
    [MODELS.judgment]: answers.judgment ?? [JSON.stringify({ problems: [] })],
  });
  const store = memoryStore({ styles, rules, cases });
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
      ["/v1/chat/completions", MODELS.judgment, "Bearer sk-test"],
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

test("부품 탐색은 VLM 모델에 여섯 방향 그림을 모음 그림 한 장으로 싣고, 그 결과가 후보 제시 요청에 담긴다", async () => {
  const { llm } = await run({});

  const [request] = llm.requests.filter((r) => r.body.model === MODELS.parts);
  const content = request.body.messages.find((m) => m.role === "user")!.content as Exclude<Content, string>;
  const images = imagesOf(content);
  // 320×240 칸 여섯을 세 칸씩 두 줄로, 칸 사이에 4픽셀 경계를 두고 잇는다
  assert.deepEqual(images.map(pngSize), [[3 * 320 + 2 * 4, 2 * 240 + 4]]);
  // 문장에는 칸마다 어느 쪽에서 본 그림인지와 부품 색이 담기고, 그림 데이터는 다시 싣지 않는다
  const [input] = llm.inputs(MODELS.parts);
  assert.deepEqual(input.views, [
    { from: "+X", sheet: 1, row: 1, column: 1 },
    { from: "-X", sheet: 1, row: 1, column: 2 },
    { from: "+Y", sheet: 1, row: 1, column: 3 },
    { from: "-Y", sheet: 1, row: 2, column: 1 },
    { from: "+Z", sheet: 1, row: 2, column: 2 },
    { from: "-Z", sheet: 1, row: 2, column: 3 },
  ]);
  assert.deepEqual(input.colors.map((c: { name: string }) => c.name), ["Carcass", "DrawerBox"]);
  assert.ok(textOf(content).length < 5_000);
  assert.match(request.body.messages.find((m) => m.role === "system")!.content as string, /"fronts"/);
  assert.deepEqual(llm.inputs(MODELS.candidates)[0].parts, parts);
});

test("AI 판정은 VLM 모델에 슬라이더 끝값 렌더링을 모음 그림으로 싣고, 문장에는 칸마다 렌더링 이름과 슬라이더 값만 담는다", async () => {
  const { llm } = await run({});

  const [request] = llm.requests.filter((r) => r.body.model === MODELS.judgment);
  const content = request.body.messages.find((m) => m.role === "user")!.content as Exclude<Content, string>;
  assert.deepEqual(imagesOf(content).map(pngSize), [[2 * 320 + 4, 240]]);
  const [input] = llm.inputs(MODELS.judgment);
  assert.deepEqual(input.renders, [
    { name: "body_w=400", values: { body_w: 400 }, sheet: 1, row: 1, column: 1 },
    { name: "body_w=800", values: { body_w: 800 }, sheet: 1, row: 1, column: 2 },
  ]);
  assert.deepEqual(input.spec, spec);
  assert.ok(textOf(content).length < 5_000);
  // 출력 형식의 그림 이름은 보낸 렌더링 이름만 고를 수 있다
  assert.match(request.body.messages.find((m) => m.role === "system")!.content as string, /"enum":\["body_w=400","body_w=800"\]/);
});

/**
 * 슬라이더 넷이면 렌더링이 2·4 + 4·C(4,2) = 32장이다. 렌더링 i는 바탕에 폭 10·(i+1)픽셀짜리 판을 그린 320×240 그림으로,
 * 판 폭이 다 달라 칸을 줄이거나 늘리면 픽셀이 어긋난다.
 */
const manyRenders = Array.from({ length: 32 }, (_, i) => {
  const rgb = new Uint8Array(320 * 240 * 3).fill(244);
  for (let y = 60; y < 180; y++) for (let x = 20; x < 20 + 10 * (i + 1) && x < 320; x++) rgb.set([200, 80, i * 7], (y * 320 + x) * 3);
  return { name: `r${i + 1}`, values: { w: i }, image: encodePng(rgb, 320, 240).toString("base64"), rgb };
});

async function judgeMany(answers: Answer[], options: { maxImages?: number } = {}) {
  const llm = await fakeLiteLlm({ [MODELS.judgment]: answers });
  try {
    const ai = liteLlmAi({ baseUrl: llm.baseUrl, models: MODELS, ...options });
    const renders = manyRenders.map(({ name, values, image }) => ({ name, values, image }));
    const answer = await ai.judge({ intake, spec, renders, colors: [], examples: [], rejected: null, schemaErrors: [] });
    return { answer, llm };
  } finally {
    await llm.close();
  }
}

test("모음 그림이 VLM 그림 수 제한(기본 3장)보다 많으면 AI 판정을 나눠 묻고 문제 목록을 합친다", async () => {
  const { answer, llm } = await judgeMany([
    JSON.stringify({ problems: [{ image: "r2", reason: "판이 몸통 밖으로 나갔다" }] }),
    JSON.stringify({ problems: [{ image: "r30", reason: "판이 너무 얇다" }] }),
  ]);

  assert.deepEqual(answer, {
    problems: [
      { image: "r2", reason: "판이 몸통 밖으로 나갔다" },
      { image: "r30", reason: "판이 너무 얇다" },
    ],
  });
  // 한 장에 아홉 칸이라 첫 요청이 27장을 모음 그림 석 장으로, 둘째 요청이 남은 다섯 장을 한 장으로 보낸다
  const sizes = llm.requests.map((r) => imagesOf(r.body.messages[1].content).map(pngSize));
  assert.deepEqual(sizes, [
    [[968, 728], [968, 728], [968, 728]],
    [[968, 484]],
  ]);
  const [first, second] = llm.inputs(MODELS.judgment);
  assert.deepEqual(first.renders[13], { name: "r14", values: { w: 13 }, sheet: 2, row: 2, column: 2 });
  assert.deepEqual(second.renders.map((r: { name: string; sheet: number }) => [r.name, r.sheet]), [["r28", 1], ["r29", 1], ["r30", 1], ["r31", 1], ["r32", 1]]);
  // 요청마다 출력 형식의 그림 이름은 그 요청에 보낸 렌더링 이름만 고를 수 있다
  assert.match(llm.requests[1].body.messages[0].content as string, /"enum":\["r28","r29","r30","r31","r32"\]/);

  // 같은 축척: r14의 칸은 줄이거나 늘리지 않고 원래 픽셀 그대로 둘째 모음 그림 가운데 칸에 있다
  const sheet = decodePng(Buffer.from(imagesOf(llm.requests[0].body.messages[1].content)[1].split(",")[1], "base64"));
  const [left, top] = [324, 244];
  for (let y = 0; y < 240; y++) {
    const row = sheet.rgb.subarray(((top + y) * sheet.width + left) * 3, ((top + y) * sheet.width + left + 320) * 3);
    assert.deepEqual(row, manyRenders[13].rgb.subarray(y * 320 * 3, (y + 1) * 320 * 3), `${y}째 줄`);
  }
});

test("VLM 그림 수 제한은 설정값이다", async () => {
  const { llm } = await judgeMany(Array(2).fill(JSON.stringify({ problems: [] })), { maxImages: 2 });

  // 한 요청에 모음 그림 두 장(18칸)까지다
  assert.deepEqual(llm.requests.map((r) => imagesOf(r.body.messages[1].content).length), [2, 2]);
});

test("나눠 물은 AI 판정 중 하나라도 형식이 틀린 답이면 그 답을 돌려줘 실행기가 다시 묻게 한다", async () => {
  const { answer } = await judgeMany([JSON.stringify({ problems: [] }), "문제 없음"]);

  assert.equal(answer, "문제 없음");
});

test("나눠 물은 AI 판정이 그 요청에 보내지 않은 렌더링을 짚으면 버리고, 모르는 이름과 출력 형식 밖의 필드는 남겨 형식 검사에 걸리게 한다", async () => {
  const { answer } = await judgeMany([
    JSON.stringify({ problems: [{ image: "r2", reason: "뚫렸다" }] }),
    // 둘째 요청은 r28~r32만 보냈다. r3은 보지 못한 그림이고 r99는 없는 렌더링이다
    JSON.stringify({ problems: [{ image: "r3", reason: "겹쳤다" }, { image: "r99", reason: "얇다" }], note: "덧붙임" }),
  ]);

  assert.deepEqual(answer, {
    note: "덧붙임",
    problems: [
      { image: "r2", reason: "뚫렸다" },
      { image: "r99", reason: "얇다" },
    ],
  });
});

test("VLM 그림 수 제한이 1 이상의 정수가 아니면 AI 모델 포트를 만들지 않는다", () => {
  // 0이면 판정이 끝나지 않고, NaN(환경 변수 오타)이면 그림 없이 통과한다
  for (const maxImages of [0, Number.NaN, 1.5]) {
    assert.throws(() => liteLlmAi({ baseUrl: "http://127.0.0.1:1", models: MODELS, maxImages }), /VLM 그림 수 제한은 1 이상의 정수/);
  }
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

test("LiteLLM이 정한 시간 안에 답하지 않으면 그 사실을 담아 실패한다", async () => {
  // 제한 시간은 LiteLLM이 예비 모델을 차례로 기다리는 시간보다 길게 둔다. 여기서는 짧게 줄여 끊기는지만 본다.
  const llm = await fakeLiteLlm({ [MODELS.style]: [JSON.stringify({ style: "natural" })] }, { delayMs: 500 });
  try {
    const ai = liteLlmAi({ baseUrl: llm.baseUrl, models: MODELS, timeoutMs: 100 });
    const candidate = { ...candidates[0], axes: { W: "X", D: "Y", H: "Z" } as const, sliders: [{ parameter: "body_w", name: "전체 폭", parent: "body_w" }] };
    await assert.rejects(ai.chooseStyle({ intake, candidate, styles, rejected: null, schemaErrors: [] }), /LiteLLM이 0\.1초 안에 답하지 않았습니다\(llm-style\)/);
  } finally {
    await llm.close();
  }
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

// LiteLLM 설정에서 모델을 바꾸면 같은 단계에 다른 모양의 답이 온다(ADR-0015). 실제로 본 모양마다 같은 녹화본으로 끝까지 간다.
const ANSWER_SHAPES: [string, (json: string) => Answer][] = [
  ["Cerebras·Groq의 gpt-oss: 추론을 reasoning 필드에 따로 싣는다", (json) => ({ content: json, reasoning: "정면은 -Y로 본다." })],
  ["LiteLLM이 추론을 reasoning_content로 옮긴 답", (json) => ({ content: json, reasoning_content: "정면은 -Y로 본다." })],
  ["로컬 추론 모델: content 앞에 <think> 블록을 붙인다", (json) => `<think>
정면은 -Y로 본다. {"front": "+X"}는 아니다.
</think>

${json}`],
];

for (const [shape, answer] of ANSWER_SHAPES) {
  test(`모델을 바꿔도 같은 녹화본으로 제출까지 간다: ${shape}`, async () => {
    const { result, store, llm } = await run({
      parts: [answer(JSON.stringify(parts))],
      candidates: [answer(JSON.stringify(candidates))],
      style: [answer(JSON.stringify({ style: "natural" }))],
      spec: [answer(JSON.stringify(spec))],
      judgment: [answer(JSON.stringify({ problems: [] }))],
    });

    assert.equal(result.status, "submitted");
    assert.deepEqual(JSON.parse(store.submissions[0].files["spec.json"]), spec);
    // 형식 오류로 다시 묻지 않고 단계마다 한 번씩만 물었다
    assert.equal(llm.requests.length, 5);
  });
}

test("내용이 빈 답(추론만 하다 끝난 답)은 조립으로 가지 않고, 형식 오류로 다시 묻는다", async () => {
  const { result, llm } = await run({ spec: [{ content: null, reasoning: "축을 정하는 중" }, JSON.stringify(spec)] });

  assert.equal(result.status, "submitted");
  const [, retry] = llm.inputs(MODELS.spec);
  assert.deepEqual(retry.rejected, "");
  assert.deepEqual(retry.schemaErrors, ["(최상위): JSON으로 읽을 수 없는 답입니다. 설명 없이 JSON 하나만 내세요"]);
});

test("LiteLLM이 오류로 답하면 그 상태와 이유를 담아 실패한다", async () => {
  // 명세 작성 모델에 남은 답이 없으면 가짜 프록시가 500으로 답한다
  await assert.rejects(run({ spec: [] }), /LiteLLM.*500.*llm-spec에 남은 답이 없습니다/);
});

test("사례 예시는 후보 제시·명세 작성·AI 판정 요청에 담기고, 지시문이 그 쓰임을 알린다", async () => {
  const cases = memoryCaseStore();
  const past = pastCase("2단 서랍장", intake.memo);
  await cases.record(past);

  const { llm } = await run({}, cases);

  for (const model of [MODELS.candidates, MODELS.spec, MODELS.judgment]) {
    assert.deepEqual(llm.inputs(model)[0].examples, [past], model);
    const [request] = llm.requests.filter((r) => r.body.model === model);
    assert.match(textOf(request.body.messages[0].content), /examples\(/, model);
  }
});

test("임베딩은 LiteLLM 임베딩 API로 문장마다 벡터 하나를 받는다", async () => {
  const requests: { path: string; authorization: string | undefined; body: { model: string; input: string[] } }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization, body: JSON.parse(raw) });
      // OpenAI 호환 API는 index로 순서를 알리므로, 일부러 뒤집어 보낸다
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const embed = liteLlmEmbed({ baseUrl: `http://127.0.0.1:${port}/litellm`, apiKey: "sk-test", model: "embedding" });

    assert.deepEqual(await embed(["가", "나"]), [[1, 0], [0, 1]]);
    assert.deepEqual(requests, [{ path: "/litellm/v1/embeddings", authorization: "Bearer sk-test", body: { model: "embedding", input: ["가", "나"] } }]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
