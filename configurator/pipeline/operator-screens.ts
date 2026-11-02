// 운영자 화면: 정보 입력 양식, 후보 카드, 최종 승인. 화면은 HTML 문장으로 만들고, 보낸 양식 값을 정보 입력과 사람 결정으로 읽는다.
// 화면을 띄우는 서버(운영 호스트)는 티켓 22에서 붙인다. 이 파일은 DOM 없이 Node에서 돈다.
import { placeOf, type Spec } from "../src/engine.ts";
import { DIMENSION_NAMES, pickParent, type CandidateCard, type ParentChoice } from "./candidate-cards.ts";
import type { Feedback } from "./feedback.ts";
import { DIMENSIONS } from "./measure.ts";
import { JUDGMENT_FAILURES, type Intake } from "./runner.ts";
import { checkIntake, PRODUCT_KINDS, THICKNESS_CHOICES, type ThicknessExposure } from "./schemas.ts";
import type { JudgmentMeasured } from "./verify-judgment.ts";

/** 두께 선택 노출 여부를 화면에 쓰는 말. 고를 거리는 THICKNESS_CHOICES 순서이고, 처음 것이 기본값이다. */
const THICKNESS_LABELS: Record<ThicknessExposure, string> = { ai: "AI 판단", show: "보이기", hide: "숨기기" };

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
body { font-family: sans-serif; margin: 24px; }
label { display: block; margin: 12px 0 4px; }
.cards { display: flex; flex-wrap: wrap; gap: 16px; }
.candidate { border: 1px solid #ccc; border-radius: 8px; padding: 12px; }
.candidate figure, .judgment figure { display: inline-block; margin: 4px; text-align: center; }
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

/** 부모 고르기 단추의 양식 이름. 카드마다 따로라 고른 카드의 값만 읽는다. */
const parentField = (cardId: string, parameter: string) => `parent:${cardId}:${parameter}`;

const alsoChangesText = (alsoChanges: string[]) => (alsoChanges.length > 0 ? ` · ${escape(alsoChanges.join(", "))}도 같이 변함` : "");

/**
 * 슬라이더 하나: 이름과 같이 변하는 다른 치수. 자식 치수의 부모 후보가 여럿이면 부모마다 고르는 단추가 있고 처음 것이 골라져 있다.
 * 부모 후보가 하나면 고를 것 없이 움직이는 부모만 적는다.
 */
function sliderHtml(cardId: string, { parameter, name, options }: ParentChoice): string {
  if (options.length === 1) {
    const [{ parent, alsoChanges }] = options;
    return `<p>${escape(name)}(${escape(parameter)}${parent === parameter ? "" : ` ← ${escape(parent)}`})${alsoChangesText(alsoChanges)}</p>`;
  }
  const radios = options.map(
    ({ parent, alsoChanges }, i) =>
      `<label><input type="radio" name="${escape(parentField(cardId, parameter))}" value="${escape(parent)}"${i === 0 ? " checked" : ""}> ${escape(parent)}${alsoChangesText(alsoChanges)}</label>`,
  );
  return `<fieldset><legend>${escape(name)}(${escape(parameter)})을 바꾸려고 움직일 부모</legend>
${radios.join("\n")}
</fieldset>`;
}

function cardHtml(card: CandidateCard): string {
  const axes = DIMENSIONS.map((a) => `${a} ${DIMENSION_NAMES[a]} = ${card.axes[a]}축`).join(" · ");
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
${card.choices.map((choice) => sliderHtml(card.id, choice)).join("\n")}
<p>${card.showThickness ? "두께 선택 보이기" : "두께 선택 숨김"}</p>
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

/** 보낸 후보 선택 양식을 사람 결정으로 읽는다. 고른 카드에서 부모 후보가 여럿인 자식 치수마다 고른 부모도 읽는다. */
export function readCandidateChoice(
  form: URLSearchParams,
  cards: CandidateCard[],
): { candidate: string; parents: Record<string, string> } | { errors: string[] } {
  const card = cards.find((c) => c.id === form.get("candidate"));
  if (!card) return { errors: ["제시된 후보 중 하나를 고르세요"] };
  const parents: Record<string, string> = {};
  const errors: string[] = [];
  for (const choice of card.choices.filter((c) => c.options.length > 1)) {
    const picked = pickParent(choice, form.get(parentField(card.id, choice.parameter)) ?? undefined);
    if ("error" in picked) errors.push(picked.error);
    else parents[choice.parameter] = picked.parent;
  }
  return errors.length > 0 ? { errors } : { candidate: card.id, parents };
}

/**
 * 최종 승인 화면. 슬라이더마다 이름과 범위가 있고, AI 판정만 JUDGMENT_FAILURES번 실패해 넘어왔으면 마지막 판정 이유와 그 렌더링이 보인다(사용자 스토리 73).
 * 이름 고치기·범위 좁히기·반려는 티켓 20에서 붙인다.
 */
export function finalApprovalHtml({ spec, judgment }: { spec: Spec; judgment: Feedback[] }): string {
  const sliders = spec.sliders.map((s) => `<li>${escape(s.name)} ${s.min}~${s.max} ${escape(s.unit)} (기본 ${s.default})</li>`).join("\n");
  const reasons = judgment.map((f) => {
    const { image, values, reason } = f.measured as JudgmentMeasured;
    const place = escape(placeOf(values));
    return `<figure><img src="${escape(image)}" alt="${place}"><figcaption>${place}: ${escape(reason)}</figcaption></figure>`;
  });
  const judged =
    reasons.length === 0
      ? ""
      : `<section class="judgment">
<h2>AI 판정을 ${JUDGMENT_FAILURES}번 통과하지 못해 넘어왔습니다</h2>
<p>수치 검증과 축 반응은 통과했습니다. 아래 렌더링을 눈여겨보고 결정하세요.</p>
${reasons.join("\n")}
</section>
`;
  return page(
    `${spec.product} 최종 승인`,
    `<h1>${escape(spec.product)} 최종 승인</h1>
${judged}<ul>
${sliders}
</ul>
<form method="post">
<p><button type="submit" name="decision" value="approve">승인</button></p>
</form>`,
  );
}
