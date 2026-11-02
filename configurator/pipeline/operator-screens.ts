// 운영자 화면: 정보 입력 양식, 후보 카드, 최종 승인. 화면은 HTML 문장으로 만들고, 보낸 양식 값을 정보 입력과 사람 결정으로 읽는다.
// 화면을 띄우는 서버(운영 호스트)는 티켓 22에서 붙인다. 이 파일은 DOM 없이 Node에서 돈다.
import { placeOf, type Spec } from "../src/engine.ts";
import type { ProductFiles } from "./assemble.ts";
import { DIMENSION_NAMES, pickParent, type CandidateCard, type ParentChoice } from "./candidate-cards.ts";
import type { Feedback } from "./feedback.ts";
import { DIMENSIONS } from "./measure.ts";
import { JUDGMENT_FAILURES, type ApprovalDecision, type Intake, type SliderEdits } from "./runner.ts";
import { approvalEditChecker, checkIntake, PRODUCT_KINDS, rejectionReasonErrors, THICKNESS_CHOICES, type ThicknessExposure } from "./schemas.ts";
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

/** script 요소 안에 싣는 고정 코어 번들. 번들 안의 "</script"가 요소를 닫지 않게 끊는다. */
const inlineScript = (code: string) => code.replace(/<\/script/gi, "<\\/script");

/** script 요소 안에 싣는 JSON. "<"를 이스케이프해 요소를 닫거나 주석을 열지 않게 한다. */
const inlineJson = (json: string) => json.replace(/</g, "\\u003c");

/** 최종 승인 양식에서 슬라이더마다 고치는 칸의 이름: 칸 + 구분자 + 슬라이더 id. 구성기를 다시 띄우는 화면 스크립트도 같은 구분자로 찾는다. */
const EDIT_FIELD_SEPARATOR = ":";
const editField = (field: "name" | "min" | "max", id: string) => `${field}${EDIT_FIELD_SEPARATOR}${id}`;

/**
 * 슬라이더 하나의 고치는 칸. 범위는 승인 전 범위 안에서 기본값을 넘지 않게만 좁힐 수 있다(사용자 스토리 70).
 * 기본값은 업로드한 모델의 값이라 고칠 수 없다. 칸 값은 막혀서 다시 묻는 결정이 고친 내용(edit)이고, 없으면 승인 전 명세의 값이다.
 * step 맞춤은 기본값 기준이라 브라우저 검사(min 속성 기준)에 맡기지 않고 approvalEditChecker가 본다.
 */
function sliderEditHtml({ id, name, min, max, default: value, unit }: Spec["sliders"][number], edit: SliderEdits[string] = {}): string {
  const range = (field: "min" | "max", current: number, low: number, high: number) =>
    `<input type="number" name="${escape(editField(field, id))}" value="${current}" min="${low}" max="${high}" step="any" required>`;
  return `<fieldset><legend>${escape(id)} (기본 ${value} ${escape(unit)})</legend>
<label>이름 <input name="${escape(editField("name", id))}" value="${escape(edit.name ?? name)}" required></label>
<label>최소 ${range("min", edit.min ?? min, min, value)}</label>
<label>최대 ${range("max", edit.max ?? max, value, max)}</label>
</fieldset>`;
}

/**
 * 결과물의 고정 코어로 구성기를 띄우는 부분. 운영자가 고객이 볼 화면을 직접 조작해 본다(사용자 스토리 68).
 * 고친 이름과 범위는 양식 값이 바뀔 때마다 구성기에 다시 띄워 보인다.
 */
function previewHtml(spec: Spec, files: ProductFiles): string {
  const product = `{"spec":${JSON.stringify(spec)},"sweeps":${files["sweeps.json"]},"style":${files["style.json"]}}`;
  return `<div id="preview" style="max-width:640px"></div>
<script>${inlineScript(files["configurator.js"])}</script>
<script type="application/json" id="product">${inlineJson(product)}</script>
<script>
// 양식이 아래에 있어 문서를 다 읽은 뒤 띄운다
document.addEventListener("DOMContentLoaded", () => {
  const { spec, sweeps, style } = JSON.parse(document.getElementById("product").textContent);
  const preview = document.getElementById("preview");
  const form = document.getElementById("approval");
  let configurator = Configurator.mount(preview, spec, sweeps, style);
  const show = () => {
    const value = (field, id) => form.elements[field + ${JSON.stringify(EDIT_FIELD_SEPARATOR)} + id].value;
    const sliders = spec.sliders.map((s) => ({ ...s, name: value("name", s.id), min: Number(value("min", s.id)), max: Number(value("max", s.id)) }));
    // 고치는 중이라 범위가 아직 맞지 않으면 앞의 구성기를 그대로 둔다(맞는지는 제출할 때 서버가 본다)
    if (sliders.some((s) => !(s.min <= s.default && s.default <= s.max && s.min < s.max))) return;
    configurator.dispose();
    configurator = Configurator.mount(preview, { ...spec, sliders }, sweeps, style);
  };
  // 다시 묻는 화면은 칸에 앞서 고친 값이 있으므로 그 값으로 다시 띄운다
  show();
  form.addEventListener("change", show);
});
</script>`;
}

/**
 * 최종 승인 화면. 결과물로 띄운 구성기, 슬라이더마다 이름과 범위를 고치는 칸, 승인과 반려 두 경로(다른 후보 고르기, 거절 이유를 적어 후보 제시 다시 하기)가 있다.
 * AI 판정만 JUDGMENT_FAILURES번 실패해 넘어왔으면 마지막 판정 이유와 그 렌더링이(사용자 스토리 73), 앞서 낸 결정이 막혔으면 그 까닭이 보인다.
 */
export function finalApprovalHtml({
  spec,
  files,
  judgment,
  errors,
  edits,
}: {
  spec: Spec;
  files: ProductFiles;
  judgment: Feedback[];
  errors: string[];
  edits: SliderEdits;
}): string {
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
  const blocked = errors.length === 0 ? "" : `<ul class="errors">\n${errors.map((e) => `<li>${escape(e)}</li>`).join("\n")}\n</ul>\n`;
  // 반려 단추는 고치는 칸의 브라우저 검사를 건너뛴다. 반려하면 고친 내용은 쓰지 않는다.
  return page(
    `${spec.product} 최종 승인`,
    `<h1>${escape(spec.product)} 최종 승인</h1>
${judged}${blocked}${previewHtml(spec, files)}
<form method="post" id="approval">
${spec.sliders.map((s) => sliderEditHtml(s, edits[s.id])).join("\n")}
<p><button type="submit" name="decision" value="approve">승인</button></p>
<p><button type="submit" name="decision" value="choice" formnovalidate>반려하고 다른 후보 고르기</button></p>
<p><label>거절 이유(한 줄) <input name="reason" size="60"></label>
<button type="submit" name="decision" value="candidates" formnovalidate>반려하고 후보 다시 받기</button></p>
</form>`,
  );
}

/**
 * 보낸 최종 승인 양식을 사람 결정으로 읽는다. 승인이면 승인 전 명세와 달라진 이름과 범위만 고친 내용으로 담는다.
 * 범위를 넓혔거나 숫자가 아니거나, 거절 이유가 한 줄이 아니면 오류를 돌려준다.
 */
export function readFinalApproval(form: URLSearchParams, spec: Spec): ApprovalDecision | { errors: string[] } {
  const decision = form.get("decision");
  if (decision === "choice") return { decision: "reject", back: "choice" };
  if (decision === "candidates") {
    const reason = form.get("reason") ?? "";
    const errors = rejectionReasonErrors(reason);
    return errors.length > 0 ? { errors } : { decision: "reject", back: "candidates", reason: reason.trim() };
  }
  if (decision !== "approve") return { errors: ["/decision: 승인(approve)하거나 반려(choice, candidates)하세요"] };

  const edits: SliderEdits = {};
  for (const slider of spec.sliders) {
    const text = (field: "name" | "min" | "max") => (form.get(editField(field, slider.id)) ?? "").trim();
    // 빈 칸은 숫자가 아니다(Number("")는 0)
    const number = (field: "min" | "max") => (text(field) === "" ? NaN : Number(text(field)));
    const edit: SliderEdits[string] = {};
    if (text("name") !== slider.name) edit.name = text("name");
    if (number("min") !== slider.min) edit.min = number("min");
    if (number("max") !== slider.max) edit.max = number("max");
    if (Object.keys(edit).length > 0) edits[slider.id] = edit;
  }
  const errors = approvalEditChecker(spec)(edits);
  return errors.length > 0 ? { errors } : { decision: "approve", edits };
}
