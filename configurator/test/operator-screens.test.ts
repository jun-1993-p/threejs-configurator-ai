// 운영자 화면: 정보 입력 양식, 후보 카드, 최종 승인. 화면은 HTML 문장으로 만들고, 보낸 양식 값을 사람 결정으로 읽는다.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CandidateCard } from "../pipeline/candidate-cards.ts";
import type { Feedback } from "../pipeline/feedback.ts";
import { candidateCardsHtml, finalApprovalHtml, intakeFormHtml, readCandidateChoice, readIntakeForm } from "../pipeline/operator-screens.ts";
import type { Spec } from "../src/engine.ts";

/** 양식에서 이름이 name인 입력 요소들(input·select·textarea) */
const fieldsNamed = (html: string, name: string) => html.match(new RegExp(`<(input|select|textarea)[^>]*name="${name}"[^>]*>`, "g")) ?? [];

test("정보 입력 양식에 상품명·상품 종류 목록·범위 메모·두께 선택 노출 여부가 있고 직업 항목은 없다", () => {
  const html = intakeFormHtml();

  assert.equal(fieldsNamed(html, "name").length, 1);
  assert.match(fieldsNamed(html, "memo").join(""), /<textarea/);
  const kinds = [...html.matchAll(/<option value="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  assert.ok(["서랍장", "책장", "수납장", "테이블"].every((kind) => kinds.includes(kind)));
  // 두께 선택 노출 여부는 기본이 "AI 판단"이다
  assert.match(html, /<option value="ai" selected>AI 판단<\/option>/);
  assert.deepEqual([...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort(), ["kind", "memo", "name", "thickness"]);
  assert.doesNotMatch(html, /직업/);
});

test("보낸 정보 입력 양식을 정보 입력으로 읽고, 두께 선택 노출 여부를 비우면 AI 판단이다", () => {
  const form = new URLSearchParams({ name: " 1단 서랍장 ", kind: "서랍장", memo: "폭 400~900" });

  assert.deepEqual(readIntakeForm(form), { intake: { name: "1단 서랍장", kind: "서랍장", memo: "폭 400~900", thickness: "ai" } });
});

test("상품 종류가 목록 밖이거나 상품명이 비었으면 정보 입력 대신 오류를 돌려준다", () => {
  const read = readIntakeForm(new URLSearchParams({ name: "", kind: "가구", memo: "", thickness: "hide" }));

  assert.ok("errors" in read);
  assert.match(read.errors.join("\n"), /\/name/);
  assert.match(read.errors.join("\n"), /\/kind: .*서랍장/);
});

const png = "iVBORw0KGgo=";
const cards: CandidateCard[] = [
  {
    id: "c1",
    front: "-Y",
    sliders: [{ parameter: "body_w", name: "전체 폭" }],
    showThickness: false,
    summary: "전체 폭 하나",
    diff: "정면 -Y <서랍 쪽>",
    axes: { W: "X", D: "Y", H: "Z" },
    previews: [{ parameter: "body_w", values: [300, 600, 900], images: [png, png, png] }],
    choices: [{ parameter: "body_w", name: "전체 폭", options: [{ parent: "body_w", alsoChanges: ["몸통 폭", "서랍 폭"] }] }],
  },
  {
    id: "c2",
    front: "+X",
    sliders: [{ parameter: "d5", name: "서랍 폭" }, { parameter: "body_h", name: "전체 높이" }],
    showThickness: true,
    summary: "서랍 폭과 높이",
    diff: "정면 +X, 높이도 노출",
    axes: { W: "Y", D: "X", H: "Z" },
    previews: [
      { parameter: "body_w", values: [300, 600, 900], images: [png, png, png] },
      { parameter: "body_h", values: [350, 700, 1050], images: [png, png, png] },
    ],
    choices: [
      {
        parameter: "d5",
        name: "서랍 폭",
        options: [
          { parent: "body_w", alsoChanges: ["전체 폭", "몸통 폭"] },
          { parent: "gap", alsoChanges: [] },
        ],
      },
      { parameter: "body_h", name: "전체 높이", options: [{ parent: "body_h", alsoChanges: [] }] },
    ],
  },
];

test("후보 카드마다 차이 한 줄, W·D·H 축 대응, 변형 미리보기 그림과 고르는 단추가 있다", () => {
  const html = candidateCardsHtml("1단 서랍장", cards);

  const [first, second] = html.split('<article class="candidate"').slice(1);
  assert.match(first, /정면 -Y &lt;서랍 쪽&gt;/);
  assert.match(first, /W 폭 = X축 · D 깊이 = Y축 · H 높이 = Z축/);
  assert.match(second, /W 폭 = Y축 · D 깊이 = X축 · H 높이 = Z축/);
  assert.equal(first.match(/<img src="data:image\/png;base64,iVBORw0KGgo="/g)?.length, 3);
  assert.equal(second.match(/<img /g)?.length, 6);
  assert.match(second, /body_h = 1050/);
  assert.match(first, /<input type="radio" name="candidate" value="c1"/);
  assert.match(second, /두께 선택 보이기/);
  assert.match(first, /두께 선택 숨김/);
});

test("자식 치수의 부모 후보마다 고르는 단추와 같이 변하는 치수가 카드에 적힌다", () => {
  const [first, second] = candidateCardsHtml("1단 서랍장", cards).split('<article class="candidate"').slice(1);

  assert.match(second, /서랍 폭\(d5\)을 바꾸려고 움직일 부모/);
  assert.match(second, /<input type="radio" name="parent:c2:d5" value="body_w" checked> body_w · 전체 폭, 몸통 폭도 같이 변함/);
  assert.match(second, /<input type="radio" name="parent:c2:d5" value="gap"> gap<\/label>/);
  assert.match(second, /<p>전체 높이\(body_h\)<\/p>/);
  // 부모 파라미터인 슬라이더는 고를 것 없이 같이 변하는 다른 치수만 적힌다
  assert.match(first, /<p>전체 폭\(body_w\) · 몸통 폭, 서랍 폭도 같이 변함<\/p>/);
  assert.doesNotMatch(first, /움직일 부모/);
});

test("고른 카드의 자식 치수마다 고른 부모를 읽고, 부모를 고르지 않았거나 후보 밖이면 오류를 돌려준다", () => {
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c2", "parent:c2:d5": "gap" }), cards), { candidate: "c2", parents: { d5: "gap" } });
  const missing = "서랍 폭(d5)을 바꾸려고 움직일 부모를 고르세요(body_w, gap)";
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c2" }), cards), { errors: [missing] });
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c2", "parent:c2:d5": "body_h" }), cards), {
    errors: [`${missing}. body_h는 부모 후보가 아닙니다`],
  });
});

test("보낸 후보 선택 양식을 고른 후보로 읽고, 제시하지 않은 후보면 오류를 돌려준다", () => {
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c1" }), cards), { candidate: "c1", parents: {} });
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c9" }), cards), { errors: ["제시된 후보 중 하나를 고르세요"] });
  assert.deepEqual(readCandidateChoice(new URLSearchParams(), cards), { errors: ["제시된 후보 중 하나를 고르세요"] });
});

const approvedSpec = {
  product: "1단 서랍장",
  sliders: [
    { id: "body_w", name: "전체 폭", min: 400, max: 800, default: 600, unit: "mm" },
    { id: "body_h", name: "전체 높이", min: 500, max: 1000, default: 700, unit: "mm" },
  ],
} as Spec;

const judgment: Feedback[] = [
  {
    path: "sliders[0]",
    slider: "body_w",
    part: "",
    kind: "ai_judgment",
    measured: { image: "renders/1단 서랍장/body_w=800·body_h=500.png", values: { body_w: 800, body_h: 500 }, reason: "서랍이 몸통 밖으로 <튀어나옴>" },
    expected: "뚫림·겹침·비례 깨짐 없음",
    hint: "",
  },
];

test("AI 판정만 3번 실패해 넘어온 구성기의 최종 승인 화면에는 판정 이유와 그 렌더링이 보인다", () => {
  const html = finalApprovalHtml({ spec: approvedSpec, judgment });

  assert.match(html, /AI 판정을 3번 통과하지 못해 넘어왔습니다/);
  assert.match(html, /body_w=800·body_h=500: 서랍이 몸통 밖으로 &lt;튀어나옴&gt;/);
  assert.match(html, /<img src="renders\/1단 서랍장\/body_w=800·body_h=500\.png"/);
  assert.match(html, /전체 폭 400~800 mm \(기본 600\)/);
  assert.match(html, /<button type="submit" name="decision" value="approve">/);
});

test("AI 판정을 통과한 구성기의 최종 승인 화면에는 판정 이유가 없다", () => {
  const html = finalApprovalHtml({ spec: approvedSpec, judgment: [] });

  assert.doesNotMatch(html, /AI 판정/);
  assert.match(html, /전체 높이 500~1000 mm \(기본 700\)/);
});
