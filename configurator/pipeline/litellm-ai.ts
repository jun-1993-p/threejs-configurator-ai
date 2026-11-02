// AI 모델 포트의 LiteLLM 구현. LiteLLM 프록시의 OpenAI 호환 채팅 API로 단계마다 정해진 모델을 부른다(ADR-0015).
// 응답 형식 검사와 다시 묻기는 실행기가 한다. 여기서는 묻고, 모델이 낸 문장을 JSON으로 읽어 돌려줄 뿐이다.
// 특정 API에만 있는 기능(JSON 모드 등)에 기대지 않도록, 출력 형식은 JSON Schema를 지시문에 적어 알린다.
import { boundsOf, round } from "./measure.ts";
import { sweepResponse } from "./parameter-relations.ts";
import type { AiPort, AiStage } from "./runner.ts";
import { CANDIDATES_SCHEMA, PARTS_SCHEMA, SPEC_SCHEMA, styleChoiceSchema } from "./schemas.ts";
import type { UploadBundle } from "./upload-bundle.ts";

export interface LiteLlmOptions {
  /** LiteLLM 프록시 주소(예: http://localhost:4000) */
  baseUrl: string;
  apiKey?: string;
  /** 단계별 모델 이름. LiteLLM 설정의 model_name이라, 실제 모델은 LiteLLM 설정만 바꿔 전환한다. */
  models: Record<AiStage, string>;
}

/**
 * 모델에 보내는 업로드 묶음 요약. 격자 점은 수 MB라 빼고, 부품은 기본 형상의 바운딩 박스(Fusion 좌표, mm)로,
 * 스윕은 범위와 애드인이 범위를 줄인 기록·위상 묶음 수, 단독 스윕의 축 반응(response)으로 줄인다.
 * 축 반응은 d12처럼 이름이 뜻을 말하지 않는 파라미터의 슬라이더 이름을 짓는 근거다(사용자 스토리 28).
 */
export function bundleForPrompt(bundle: UploadBundle) {
  return {
    parameters: bundle.parameters,
    parts: bundle.parts.map((part) => {
      const { lo, hi } = boundsOf((visit) => {
        for (const i of part.faces) for (const [x, y, z] of bundle.baseline.faces[i].points) visit(x, y, z);
      });
      return { name: part.name, min: lo.map(round), size: hi.map((h, c) => round(h - lo[c])) };
    }),
    sweeps: bundle.sweeps.map(({ parameter, range, reductions, groups }) => ({
      parameter,
      range,
      ...(reductions?.length ? { reductions: reductions.map(({ side, at, reason }) => ({ side, at, reason })) } : {}),
      // groups는 기본 묶음 밖의 위상 묶음이라, 기본 묶음을 더한 것이 그 파라미터의 위상 묶음 수다
      ...(groups?.length ? { topologyGroups: groups.length + 1 } : {}),
      response: sweepResponse(bundle, parameter),
    })),
  };
}

/**
 * 지시문에 넣을 JSON Schema: 같은 스키마 안의 참조(#/$defs/…)를 풀고 $defs를 뺀다.
 * 작은 모델은 {"$ref": …}를 값의 모양으로 옮겨 적기 때문이다. 스키마의 $defs끼리는 서로 참조하지 않는다.
 */
function inlineRefs(schema: object): object {
  const defs = (schema as { $defs?: Record<string, unknown> }).$defs ?? {};
  const inline = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(inline);
    if (node === null || typeof node !== "object") return node;
    const ref = (node as { $ref?: string }).$ref?.match(/^#\/\$defs\/(.+)$/);
    if (ref) return defs[ref[1]];
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$defs").map(([key, value]) => [key, inline(value)]));
  };
  return inline(schema) as object;
}

/** 모든 단계에 같이 붙는 출력 규칙 */
const OUTPUT_RULES = (schema: object) =>
  [
    "답은 아래 JSON Schema를 따르는 JSON 하나만 낸다. 설명, 마크다운, 코드 블록 표시를 붙이지 않는다.",
    "입력의 schemaErrors가 비어 있지 않으면 rejected가 그 형식 검사에 걸린 직전 답이다. 오류 위치를 고쳐 전체 답을 다시 낸다.",
    JSON.stringify(inlineRefs(schema)),
  ].join("\n");

const PARTS_PROMPT = `너는 가구 쇼핑몰 구성기를 만들기 전에 가구 그림에서 부품을 찾는다.
입력: intake(정보 입력), views(붙인 그림의 순서대로, 각 그림을 어느 쪽에서 봤는지: Fusion 좌표 방향), colors(그림에서 부품마다 칠한 색).
- 그림은 기본 형상을 그 방향에서 본 직교 투영이다. X·Y 쪽에서 본 그림은 Z가 위, Z 쪽에서 본 그림은 Y가 위다.
- parts는 colors의 부품마다 name(colors의 name 그대로)과 role(서랍·몸통·상판·문 같은 역할, 한국어)이다.
- up은 가구가 바닥에 놓였을 때 위쪽 방향이다.
- fronts는 고객이 가구를 마주하는 정면 방향(서랍 손잡이·문이 보이는 쪽)이다. 확신하면 하나만, 확신하지 못하면 가능성 높은 순서로 2~4개 낸다. up과 같은 축은 정면이 될 수 없다.`;

const CANDIDATES_PROMPT = `너는 가구 쇼핑몰 구성기의 슬라이더 구성 후보를 제시한다.
입력: bundle(Fusion 업로드 묶음 요약: 파라미터 이름·값·수식, 부품과 바운딩 박스, 스윕한 파라미터와 범위·단독 스윕의 축 반응), intake(정보 입력), parts(그림으로 찾은 부품 역할·정면 후보·위쪽), failures(앞서 검증을 통과하지 못한 후보와 마지막 검증 피드백).
- 답은 후보 객체 2~4개를 담은 JSON 배열 하나([ … ])다. 후보끼리 정면(front)·노출할 치수의 파라미터(sliders의 parameter)·두께 선택 노출(showThickness) 중 하나 이상이 다르다.
- sliders는 고객이 바꿀 치수마다 하나다. parameter는 그 치수의 파라미터로, bundle.sweeps에 있는 부모 파라미터이거나, 고객이 원하는 치수가 수식으로 부모를 따르는 자식 파라미터면 그 자식이다(움직일 부모는 운영자가 고른다). 개수형(is_count) 파라미터는 쓰지 않는다.
- sliders의 name은 Fusion 파라미터 이름이 아니라 고객이 보는 치수의 뜻을 따른 한국어 슬라이더 이름이다(예: d12 → "서랍 폭"). 파라미터 이름이 뜻을 말하지 않으면 bundle.sweeps의 response(단독 스윕에서 상품 전체 overall과 부품 parts가 Fusion 축 X·Y·Z로 바뀐 치수 size·위치 move, mm)와 parts의 역할을 보고 짓는다.
- front는 고객이 가구를 바라보는 정면 방향(Fusion 좌표)이다. parts.fronts가 하나면 그 정면을 쓰고, 여럿이면 그 정면을 후보끼리 모두 나눠 쓴다. parts.up과 같은 축은 정면이 될 수 없다.
- summary는 후보 설명 한 줄, diff는 다른 후보와의 차이 한 줄(한국어).
- failures에 있는 후보는 같은 구성으로 다시 내지 않는다.`;

const STYLE_PROMPT = `너는 가구 쇼핑몰 구성기의 UI 스타일을 고른다.
입력: intake(정보 입력), candidate(고른 슬라이더 구성 후보), styles(고를 수 있는 스타일 목록: id, summary(분위기 설명), colors(바탕·글자·강조·부품 색), font(글꼴), slider(슬라이더 모양)).
- intake의 상품 종류·상품명과 어울리는 스타일을 summary와 colors로 판단해 그 id 하나만 고른다. 목록 밖의 값을 만들지 않는다.`;

const SPEC_PROMPT = `너는 가구 쇼핑몰 구성기의 명세(JSON)를 쓴다. 명세는 고정 코어와 변형 엔진이 읽는 유일한 입력이다.
입력: bundle(Fusion 업로드 묶음 요약), intake(정보 입력), candidate(운영자가 고른 슬라이더 구성 후보), rules(이 상품 종류의 치수 규칙), previous(검증 피드백을 받은 명세, 처음이면 null), feedback(previous가 받은 검증 피드백), rejected(형식 검사에 걸린 직전 답, 없으면 null), schemaErrors(rejected의 형식 검사 오류).
- product는 intake.name 그대로다.
- front는 candidate.front다. axes는 W(폭)·D(깊이)·H(높이)가 대응하는 Fusion 축이다. 정면이 ±Y면 W는 X, D는 Y이고, 정면이 ±X면 W는 Y, D는 X다. bundle.parts의 바운딩 박스(size는 X·Y·Z 순)로 높이 축을 확인한다.
- sliders는 candidate.sliders마다 하나다. id는 그 parent(움직일 부모 파라미터), name은 그 name 그대로, unit은 "mm"다. parent가 parameter와 다르면 children에 parameter를 넣는다.
- default는 bundle.parameters에 있는 그 파라미터의 value 그대로다.
- axis는 그 파라미터가 바꾸는 치수의 축(W·D·H)이다. source는 rules 중 같은 축의 규칙 id다.
- min·max는 세 범위의 교집합 안에서 고르고 default를 담는다: source 규칙의 min~max, intake.memo에 그 부위 이름 뒤에 적힌 "값~값"(단위 없으면 mm, cm는 mm로 바꿈), bundle.sweeps에 있는 그 파라미터의 range. step은 범위를 고르게 나누는 값(보통 10)이다.
- children은 수식(expression)이 이 부모를 직접 또는 간접으로 따르는 파라미터 이름이다. 기록용이고, 수식이 따르지 않는 파라미터는 넣지 않는다.
- affects.shape는 이 슬라이더를 움직이면 크기가 바뀌는 부품, affects.move는 크기는 그대로이고 자리만 옮겨지는 부품이다. bundle.parts의 name만 쓰고, 한 부품을 둘 다에 넣지 않는다.
- thickness는 판재 두께 선택이다. candidate.showThickness가 false면 빈 목록이다. 두께 후보(options)는 표준 두께 목록 3·6·9·12·15·18·24·30 mm에서 기본 두께와 그 앞뒤 한 칸이다. ids로 묶는 두께 파라미터는 기본 두께가 같아야 하고 default는 그 값이다.
- fixed는 슬라이더로 바꾸지 않는 판재 두께 파라미터다. 어떤 슬라이더의 children에도, thickness에도 넣지 않는다. 확실하지 않으면 빈 목록이다.
- feedback이 비어 있지 않으면 previous를 바탕으로 각 항목의 path가 가리키는 곳을 고쳐 전체 명세를 다시 낸다. 그 밖의 곳은 바꾸지 않는다. measured·expected·hint가 고칠 값을 알려 준다.`;

/** 답 전체를 감싼 마크다운 코드 블록(```json … ```) */
const CODE_BLOCK = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/;

/**
 * 모델이 낸 문장을 JSON으로 읽는다. 지시해도 코드 블록으로 감싸는 모델이 있어 감싼 것은 벗긴다.
 * 읽을 수 없으면 문장 그대로 돌려줘, 실행기의 형식 검사에 걸려 다시 묻게 한다.
 */
function readJson(content: string): unknown {
  try {
    return JSON.parse(content.match(CODE_BLOCK)?.[1] ?? content);
  } catch {
    return content;
  }
}

export function liteLlmAi({ baseUrl, apiKey, models }: LiteLlmOptions): AiPort {
  // 주소에 붙은 경로(예: /litellm) 아래의 채팅 API를 부르도록 끝을 /로 맞춘다
  const chat = new URL("v1/chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  /** images: 사용자 메시지에 문장 뒤로 붙일 PNG(base64). 있으면 OpenAI 호환 문장·그림 조각 목록으로 보낸다. */
  async function ask(stage: AiStage, instructions: string, input: unknown, images: string[] = []): Promise<unknown> {
    const text = JSON.stringify(input);
    const content =
      images.length === 0
        ? text
        : [{ type: "text", text }, ...images.map((png) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }))];
    const response = await fetch(chat, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: models[stage],
        messages: [
          { role: "system", content: instructions },
          { role: "user", content },
        ],
      }),
    });
    if (!response.ok) throw new Error(`LiteLLM 호출 실패(${models[stage]}): ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    return readJson(body.choices[0].message.content);
  }
  // 실행기가 업로드 단계에서 형식을 검사한 뒤에만 AI 단계를 부른다
  const summary = (bundle: unknown) => bundleForPrompt(bundle as UploadBundle);
  return {
    // 그림은 조각으로 붙이고, 문장에는 그림 순서대로 어느 쪽에서 본 것인지만 남긴다
    findParts: ({ views, ...input }) =>
      ask(
        "parts",
        `${PARTS_PROMPT}
${OUTPUT_RULES(PARTS_SCHEMA)}`,
        { ...input, views: views.map((v) => v.from) },
        views.map((v) => v.image),
      ),
    proposeCandidates: (input) =>
      ask("candidates", `${CANDIDATES_PROMPT}\n${OUTPUT_RULES(CANDIDATES_SCHEMA)}`, { ...input, bundle: summary(input.bundle) }),
    chooseStyle: (input) => ask("style", `${STYLE_PROMPT}\n${OUTPUT_RULES(styleChoiceSchema(input.styles.map((s) => s.id)))}`, input),
    writeSpec: (input) => ask("spec", `${SPEC_PROMPT}\n${OUTPUT_RULES(SPEC_SCHEMA)}`, { ...input, bundle: summary(input.bundle) }),
  };
}
