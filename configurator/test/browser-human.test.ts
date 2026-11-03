// 브라우저 사람 결정 포트: 운영자 화면(후보 카드, 최종 승인)을 작은 HTTP 서버로 띄우고, 운영자가 보낸 양식을 사람 결정으로 읽는다.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ProductFiles } from "../pipeline/assemble.ts";
import { browserHuman } from "../pipeline/browser-human.ts";
import type { CandidateCard } from "../pipeline/candidate-cards.ts";
import type { Spec } from "../src/engine.ts";

const cards: CandidateCard[] = [
  {
    id: "c1",
    front: "-Y",
    sliders: [{ parameter: "drawer_w", name: "서랍 폭" }],
    showThickness: false,
    summary: "서랍 폭 하나",
    diff: "서랍만",
    axes: { W: "X", D: "Y", H: "Z" },
    previews: [],
    choices: [{ parameter: "drawer_w", name: "서랍 폭", options: [{ parent: "body_w", alsoChanges: [] }, { parent: "drawer_w", alsoChanges: [] }] }],
  },
];

const spec = {
  product: "1단 서랍장",
  sliders: [{ id: "body_w", name: "전체 폭", min: 400, max: 800, default: 600, step: 10, unit: "mm" }],
} as Spec;
const files: ProductFiles = { "configurator.js": "", "spec.json": JSON.stringify(spec), "sweeps.json": "{}", "style.json": "{}", "index.html": "" };

const post = (url: string, form: Record<string, string>) => fetch(url, { method: "POST", body: new URLSearchParams(form) });

/** 화면이 결정을 기다리기 시작할 때까지 */
async function screenOf(url: string, title: string): Promise<string> {
  for (;;) {
    const html = await (await fetch(url)).text();
    if (html.includes(title)) return html;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("결정을 기다리지 않을 때는 진행 중 화면이 몇 초마다 다시 읽힌다", async () => {
  const human = await browserHuman({ product: "1단 서랍장", assets: () => undefined });
  try {
    const html = await (await fetch(human.url)).text();

    assert.match(html, /<meta http-equiv="refresh" content="\d+">/);
    assert.match(html, /진행 중/);
  } finally {
    await human.close();
  }
});

test("후보 카드 화면에서 보낸 후보와 부모를 후보 선택으로 돌려주고, 고르지 않고 보내면 그 까닭을 보이고 다시 기다린다", async () => {
  const human = await browserHuman({ product: "1단 서랍장", assets: () => undefined });
  try {
    const chosen = human.chooseCandidate(cards);
    await screenOf(human.url, "후보 선택");

    const blocked = await (await post(human.url, {})).text();
    assert.match(blocked, /제시된 후보 중 하나를 고르세요/);
    assert.match(blocked, /후보 선택/);

    const accepted = await (await post(human.url, { candidate: "c1", "parent:c1:drawer_w": "drawer_w" })).text();
    assert.deepEqual(await chosen, { candidate: "c1", parents: { drawer_w: "drawer_w" } });
    assert.match(accepted, /진행 중/);
  } finally {
    await human.close();
  }
});

test("최종 승인 화면에서 고친 이름으로 승인한 결정을 돌려주고, AI 판정 렌더링을 그 경로로 보인다", async () => {
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  const human = await browserHuman({ product: "1단 서랍장", assets: (path) => (path === "renders/1단 서랍장/body_w=800.png" ? png : undefined) });
  try {
    const decided = human.finalApproval({ spec, files, judgment: [], errors: [], edits: {} });
    await screenOf(human.url, "최종 승인");

    const image = await fetch(new URL("renders/1단 서랍장/body_w=800.png", human.url));
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await fetch(new URL("renders/없는.png", human.url))).status, 404);

    await post(human.url, { decision: "approve", "name:body_w": "가로", "min:body_w": "400", "max:body_w": "800" });
    assert.deepEqual(await decided, { decision: "approve", edits: { body_w: { name: "가로" } } });
  } finally {
    await human.close();
  }
});

test("최종 승인 화면에서 범위를 넓혀 보내면 그 까닭을 보이고 다시 기다린다", async () => {
  const human = await browserHuman({ product: "1단 서랍장", assets: () => undefined });
  try {
    const decided = human.finalApproval({ spec, files, judgment: [], errors: [], edits: {} });
    await screenOf(human.url, "최종 승인");

    const blocked = await (await post(human.url, { decision: "approve", "name:body_w": "전체 폭", "min:body_w": "300", "max:body_w": "800" })).text();
    assert.match(blocked, /\/body_w\/min/);

    await post(human.url, { decision: "choice" });
    assert.deepEqual(await decided, { decision: "reject", back: "choice" });
  } finally {
    await human.close();
  }
});
