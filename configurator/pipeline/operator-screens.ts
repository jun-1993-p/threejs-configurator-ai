// 운영자 화면: 정보 입력 양식과 후보 카드. 화면은 HTML 문장으로 만들고, 보낸 양식 값을 정보 입력과 사람 결정으로 읽는다.
// 화면을 띄우는 서버(운영 호스트)는 티켓 22에서 붙인다. 이 파일은 DOM 없이 Node에서 돈다.
import type { CandidateCard } from "./candidate-cards.ts";
import type { Intake } from "./runner.ts";
import { checkIntake, PRODUCT_KINDS, THICKNESS_CHOICES, type ThicknessExposure } from "./schemas.ts";

/** 두께 선택 노출 여부를 화면에 쓰는 말. 고를 거리는 THICKNESS_CHOICES 순서이고, 처음 것이 기본값이다. */
const THICKNESS_LABELS: Record<ThicknessExposure, string> = { ai: "AI 판단", show: "보이기", hide: "숨기기" };

const AXIS_NAMES = { W: "폭", D: "깊이", H: "높이" } as const;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
body { font-family: sans-serif; margin: 24px; }
label { display: block; margin: 12px 0 4px; }
.cards { display: flex; flex-wrap: wrap; gap: 16px; }
.candidate { border: 1px solid #ccc; border-radius: 8px; padding: 12px; }
.candidate figure { display: inline-block; margin: 4px; text-align: center; }
</style></head>
<body>
${body}
</body>
</html>
`;

/** 정보 입력 양식. 상품명·상품 종류(목록)·원하는 슬라이더와 범위 메모·두께 선택 노출 여부만 받는다(사용자 스토리 14~18). */
export function intakeFormHtml(): string {
  const option = (value: string, label: string, selected = false) => `<option value="${escape(value)}"${selected ? " selected" : ""}>${escape(label)}</option>`;
  return page(
    "정보 입력",
    `<h1>정보 입력</h1>
<form method="post">
<label for="name">상품명</label><input id="name" name="name" required>
<label for="kind">상품 종류</label><select id="kind" name="kind">${PRODUCT_KINDS.map((kind) => option(kind, kind)).join("")}</select>
<label for="memo">원하는 슬라이더와 범위 메모</label><textarea id="memo" name="memo" rows="3" placeholder="예: 폭 600~1200, 높이는 고정"></textarea>
<label for="thickness">두께 선택 노출 여부</label><select id="thickness" name="thickness">${THICKNESS_CHOICES.map((value, i) => option(value, THICKNESS_LABELS[value], i === 0)).join("")}</select>
<p><button type="submit">후보 받기</button></p>
</form>`,
  );
}

/** 보낸 정보 입력 양식을 읽는다. 두께 선택 노출 여부를 비우면 "AI 판단"이다. */
export function readIntakeForm(form: URLSearchParams): { intake: Intake } | { errors: string[] } {
  const intake = {
    name: (form.get("name") ?? "").trim(),
    kind: (form.get("kind") ?? "").trim(),
    memo: (form.get("memo") ?? "").trim(),
    thickness: form.get("thickness") || THICKNESS_CHOICES[0],
  };
  const errors = checkIntake(intake);
  // 형식 검사를 통과했으므로 상품 종류와 두께 선택 노출 여부는 목록 안의 값이다
  return errors.length > 0 ? { errors } : { intake: intake as Intake };
}

function cardHtml(card: CandidateCard): string {
  const axes = (["W", "D", "H"] as const).map((a) => `${a} ${AXIS_NAMES[a]} = ${card.axes[a]}축`).join(" · ");
  const previews = card.previews
    .map(
      ({ parameter, values, images }) =>
        `<div>${values
          .map((v, i) => `<figure><img src="data:image/png;base64,${images[i]}" alt="${escape(parameter)} = ${v}"><figcaption>${escape(parameter)} = ${v}</figcaption></figure>`)
          .join("")}</div>`,
    )
    .join("\n");
  return `<article class="candidate">
<label><input type="radio" name="candidate" value="${escape(card.id)}" required> ${escape(card.summary)}</label>
<p>${escape(card.diff)}</p>
<p>정면 ${card.front} · ${axes}</p>
<p>움직일 파라미터: ${card.parents.map(escape).join(", ")} · ${card.showThickness ? "두께 선택 보이기" : "두께 선택 숨김"}</p>
${previews}
</article>`;
}

/** 후보 카드 화면. 카드마다 다른 후보와의 차이 한 줄, 정면에 따른 축 대응, 업로드한 스윕으로 만든 변형 미리보기가 있다. */
export function candidateCardsHtml(product: string, cards: CandidateCard[]): string {
  return page(
    `${product} 후보 선택`,
    `<h1>${escape(product)} 후보 선택</h1>
<form method="post">
<div class="cards">
${cards.map(cardHtml).join("\n")}
</div>
<p><button type="submit">이 후보로 명세 작성</button></p>
</form>`,
  );
}

/** 보낸 후보 선택 양식을 사람 결정으로 읽는다 */
export function readCandidateChoice(form: URLSearchParams, cards: CandidateCard[]): { candidate: string } | { errors: string[] } {
  const id = form.get("candidate");
  return id !== null && cards.some((c) => c.id === id) ? { candidate: id } : { errors: ["제시된 후보 중 하나를 고르세요"] };
}
