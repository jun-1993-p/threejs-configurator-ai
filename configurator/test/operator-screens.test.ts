// 운영자 화면: 정보 입력 양식과 후보 카드. 화면은 HTML 문장으로 만들고, 보낸 양식 값을 사람 결정으로 읽는다.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CandidateCard } from "../pipeline/candidate-cards.ts";
import { candidateCardsHtml, intakeFormHtml, readCandidateChoice, readIntakeForm } from "../pipeline/operator-screens.ts";

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
    parents: ["body_w"],
    showThickness: false,
    summary: "전체 폭 하나",
    diff: "정면 -Y <서랍 쪽>",
    axes: { W: "X", D: "Y", H: "Z" },
    previews: [{ parameter: "body_w", values: [300, 600, 900], images: [png, png, png] }],
  },
  {
    id: "c2",
    front: "+X",
    parents: ["body_w", "body_h"],
    showThickness: true,
    summary: "폭과 높이",
    diff: "정면 +X, 높이도 노출",
    axes: { W: "Y", D: "X", H: "Z" },
    previews: [
      { parameter: "body_w", values: [300, 600, 900], images: [png, png, png] },
      { parameter: "body_h", values: [350, 700, 1050], images: [png, png, png] },
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

test("보낸 후보 선택 양식을 고른 후보로 읽고, 제시하지 않은 후보면 오류를 돌려준다", () => {
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c2" }), cards), { candidate: "c2" });
  assert.deepEqual(readCandidateChoice(new URLSearchParams({ candidate: "c9" }), cards), { errors: ["제시된 후보 중 하나를 고르세요"] });
  assert.deepEqual(readCandidateChoice(new URLSearchParams(), cards), { errors: ["제시된 후보 중 하나를 고르세요"] });
});
