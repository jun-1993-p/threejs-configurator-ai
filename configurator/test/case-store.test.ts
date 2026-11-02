// 사례 저장소(ADR-0011): JSONL 사례 기록과 LanceDB 임베딩 색인. 임베딩은 외부 모델 없이 글자 두 개 묶음 임베딩을 쓴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { DEFAULT_CASES_DIR, lanceCaseStore, ngramEmbedding, type Embed } from "../pipeline/case-store.ts";
import type { CaseRecord } from "../pipeline/runner.ts";
import { pastCase } from "./cases.ts";

const casesDir = () => mkdtempSync(join(tmpdir(), "cases-"));
const names = (records: CaseRecord[]) => records.map((r) => r.intake.name);

test("승인된 사례는 JSONL 한 줄로 기록되고, 기록한 순서대로 다시 읽힌다", async () => {
  const dir = casesDir();
  const store = lanceCaseStore({ dir, embed: ngramEmbedding });
  const first = pastCase("1단 서랍장", "폭 400~900");
  const second = pastCase("2단 서랍장", "높이 고정");

  const ids = [await store.record(first), await store.record(second)];

  const lines = readFileSync(join(dir, "cases.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { id: ids[0], ...first },
    { id: ids[1], ...second },
  ]);
  assert.deepEqual(await store.list(), lines);
  assert.notEqual(ids[0], ids[1]);
});

test("같은 상품 종류의 사례 중 검색 문장과 임베딩 유사도가 높은 순서로 정한 수만큼 나온다", async () => {
  const store = lanceCaseStore({ dir: casesDir(), embed: ngramEmbedding });
  for (const past of [
    pastCase("원목 협탁", "깊이만 바꾸고 싶음"),
    pastCase("3단 서랍장", "폭 500~900"),
    pastCase("1단 서랍장", "폭 400~900, 높이는 고정"),
    pastCase("2단 서랍장", "폭 400~800, 높이는 고정"),
    pastCase("1단 서랍장", "폭 400~900, 높이는 고정", "책장"),
  ]) {
    await store.record(past);
  }

  const found = await store.similar("서랍장", "서랍장\n1단 서랍장\n폭 400~900, 높이는 고정", 3);

  assert.deepEqual(names(found), ["1단 서랍장", "2단 서랍장", "3단 서랍장"]);
  assert.ok(found.every((r) => r.kind === "서랍장" && !("id" in r)));
  assert.deepEqual(await store.similar("테이블", "테이블", 3), []);
});

test("사례를 빼면 다음 검색부터 나오지 않는다. JSONL에서 줄을 지워도 같다", async () => {
  const dir = casesDir();
  const store = lanceCaseStore({ dir, embed: ngramEmbedding });
  const [a, b, c] = [pastCase("1단 서랍장", "폭"), pastCase("2단 서랍장", "폭"), pastCase("3단 서랍장", "폭")];
  const ids = [await store.record(a), await store.record(b), await store.record(c)];
  assert.equal((await store.similar("서랍장", "서랍장", 3)).length, 3);

  await store.remove(ids[0]);
  assert.deepEqual(names(await store.similar("서랍장", "서랍장", 3)).sort(), ["2단 서랍장", "3단 서랍장"]);

  // 운영자가 사례 기록 파일에서 줄을 직접 지운다
  const file = join(dir, "cases.jsonl");
  const kept = readFileSync(file, "utf-8").split("\n").filter((line) => line && JSON.parse(line).id !== ids[1]);
  writeFileSync(file, kept.map((line) => `${line}\n`).join(""));
  assert.deepEqual(names(await store.similar("서랍장", "서랍장", 3)), ["3단 서랍장"]);
  assert.deepEqual(names(await store.list()), ["3단 서랍장"]);
});

test("임베딩 색인은 사례 기록에서 다시 만들 수 있고, 이미 색인한 사례는 다시 임베딩하지 않는다", async () => {
  const dir = casesDir();
  const embedded: string[] = [];
  const counting: Embed = (texts) => {
    embedded.push(...texts);
    return ngramEmbedding(texts);
  };
  const store = lanceCaseStore({ dir, embed: counting });
  await store.record(pastCase("1단 서랍장", "폭"));
  await store.record(pastCase("2단 서랍장", "폭"));
  await store.similar("서랍장", "검색 1", 3);
  await store.similar("서랍장", "검색 2", 3);
  // 사례 둘은 한 번씩만 임베딩되고, 그 밖은 검색 문장이다
  assert.equal(embedded.filter((t) => !t.startsWith("검색")).length, 2);

  rmSync(join(dir, "cases.lance"), { recursive: true });
  assert.deepEqual(names(await lanceCaseStore({ dir, embed: ngramEmbedding }).similar("서랍장", "서랍장", 3)).sort(), ["1단 서랍장", "2단 서랍장"]);
});

test("기본 사례 저장소 폴더는 공개 저장소에 올라가지 않는다", () => {
  const root = new URL("../../", import.meta.url);
  const rootPath = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf-8" }).trim();
  for (const file of ["cases.jsonl", "cases.lance/cases.lance/data/x.lance"]) {
    const path = relative(rootPath, join(DEFAULT_CASES_DIR, file)).replaceAll("\\", "/");
    // check-ignore는 무시되는 경로면 그 경로를 내고 0으로 끝난다
    assert.equal(execFileSync("git", ["check-ignore", path], { cwd: rootPath, encoding: "utf-8" }).trim(), path);
  }
});

test("임베딩 모델을 바꿔 벡터 길이가 달라지면 색인을 사례 기록에서 다시 만든다", async () => {
  const dir = casesDir();
  await lanceCaseStore({ dir, embed: ngramEmbedding }).record(pastCase("1단 서랍장", "폭"));
  await lanceCaseStore({ dir, embed: ngramEmbedding }).similar("서랍장", "서랍장", 3);
  // 256칸 벡터를 8칸으로 접어 길이만 다른 모델로 삼는다
  const shorter: Embed = async (texts) => (await ngramEmbedding(texts)).map((v) => v.reduce((folded, x, i) => ((folded[i % 8] += x), folded), new Array<number>(8).fill(0)));

  assert.deepEqual(names(await lanceCaseStore({ dir, embed: shorter }).similar("서랍장", "서랍장", 3)), ["1단 서랍장"]);
});

test("운영자가 사례 기록에서 정보 입력을 고치면 그 사례를 다시 임베딩한다", async () => {
  const dir = casesDir();
  const store = lanceCaseStore({ dir, embed: ngramEmbedding });
  await store.record(pastCase("원목 협탁", "깊이만 바꾸고 싶음"));
  await store.record(pastCase("2단 서랍장", "폭 400~800"));
  const query = "서랍장\n1단 서랍장\n폭 400~900, 높이는 고정";
  assert.deepEqual(names(await store.similar("서랍장", query, 1)), ["2단 서랍장"]);

  const file = join(dir, "cases.jsonl");
  const [first, second] = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  first.intake = { ...first.intake, name: "1단 서랍장", memo: "폭 400~900, 높이는 고정" };
  writeFileSync(file, [first, second].map((c) => `${JSON.stringify(c)}\n`).join(""));

  assert.deepEqual(names(await store.similar("서랍장", query, 1)), ["1단 서랍장"]);
});

test("사례 기록에 JSON으로 읽을 수 없는 줄이 있으면 그 줄 번호를 알리며 실패한다", async () => {
  const dir = casesDir();
  const store = lanceCaseStore({ dir, embed: ngramEmbedding });
  await store.record(pastCase("1단 서랍장", "폭"));
  writeFileSync(join(dir, "cases.jsonl"), `${readFileSync(join(dir, "cases.jsonl"), "utf-8")}{"id": "깨진\n`);

  await assert.rejects(store.similar("서랍장", "서랍장", 3), /cases\.jsonl\) 2번째 줄/);
});
