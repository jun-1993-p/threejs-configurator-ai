// 사례 저장소 관리(ADR-0011): 사례를 보고, 잘못된 사례를 뺀다. 뺀 사례는 다음 상품부터 예시에 나오지 않는다.
// 사례 기록(cases.jsonl)에서 줄을 직접 지워도 같다. 임베딩 색인은 다음 검색 때 기록에 맞춰진다.
// 실행: node scripts/cases.ts list | node scripts/cases.ts remove <사례 id>
// 환경 변수: CASES_DIR(사례 저장소 폴더, 기본 저장소 루트의 data/cases)
import { DEFAULT_CASES_DIR, lanceCaseStore } from "../pipeline/case-store.ts";

// 보기와 빼기는 임베딩하지 않는다
const store = lanceCaseStore({
  dir: process.env.CASES_DIR ?? DEFAULT_CASES_DIR,
  embed: () => Promise.reject(new Error("사례 관리 도구는 임베딩하지 않습니다")),
});

const [command, id] = process.argv.slice(2);
if (command === "list") {
  for (const c of await store.list()) console.log(`${c.id}\t${c.kind}\t${c.intake.name}\t${c.chosen.sliders.map((s) => s.name).join("·")}`);
} else if (command === "remove" && id) {
  if (!(await store.list()).some((c) => c.id === id)) {
    console.error(`사례 ${id}가 없습니다`);
    process.exit(1);
  }
  await store.remove(id);
  console.log(`사례 ${id}를 뺐습니다`);
} else {
  console.error("사용법: node scripts/cases.ts list | node scripts/cases.ts remove <사례 id>");
  process.exit(2);
}
