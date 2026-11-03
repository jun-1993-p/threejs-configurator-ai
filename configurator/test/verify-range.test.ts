// 줄어든 스윕 범위: 서랍 속 비우기 면 지정점이 면 밖으로 나가는 서랍장 합성 녹화본으로 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadRangeFeedback, verifyRange } from "../pipeline/verify-range.ts";
import { depthSpec, drawerSpec, shellPointRecording, shelfRecording, shelfSpec } from "./recording.ts";

const bodyDepth = { ...depthSpec, sliders: [depthSpec.sliders[0]] };

test("업로드 때 개수형 값이 그대로인데 범위가 줄어든 스윕을 모델링 오류 의심으로 알린다", () => {
  const feedback = uploadRangeFeedback(shellPointRecording);

  assert.deepEqual(
    feedback.map((f) => [f.slider, f.kind, f.path, f.part, f.expected]),
    [
      ["body_d", "modeling_error_suspected", "", "DrawerBox", { min: 337.5 }],
      ["drawer_d", "modeling_error_suspected", "", "DrawerBox", { min: 322.5 }],
    ],
  );
  assert.match(feedback[0].hint, /225에서 면 구성이 바뀌었는데.*DrawerBox F6:inner:F5:top.*모델링 오류/);
});

test("슬라이더 범위가 줄어든 스윕 범위를 넘으면 그쪽 끝을 좁히라고 한다", () => {
  const [feedback, ...rest] = verifyRange(bodyDepth, shellPointRecording);

  assert.equal(rest.length, 0);
  assert.equal(feedback.path, "sliders[0].min");
  assert.equal(feedback.kind, "modeling_error_suspected");
  assert.deepEqual(feedback.expected, { min: 337.5 });
  const { value, at } = feedback.measured as { value: number; at: number };
  assert.deepEqual([value, at], [300, 225]);
  assert.match(feedback.hint, /body_d의 min 값을 337\.5 이상으로 좁히세요/);
});

test("줄어든 스윕 범위 안의 슬라이더와 줄지 않은 스윕의 슬라이더는 피드백이 없다", () => {
  const inside = { ...bodyDepth, sliders: [{ ...bodyDepth.sliders[0], min: 337.5 }] };

  assert.deepEqual(verifyRange(inside, shellPointRecording), []);
  assert.deepEqual(verifyRange(drawerSpec, shellPointRecording), []);
});

test("개수형 값과 함께 면 구성이 바뀌어 줄어든 범위는 range_shrunk로 알린다", () => {
  const bundle = structuredClone(shellPointRecording);
  const [reduction] = bundle.sweeps.find((s) => s.parameter === "body_d")!.reductions!;
  Object.assign(reduction, { reason: "range_shrunk", counts: { shelves: [2, 1] } });

  const [feedback] = verifyRange(bodyDepth, bundle);

  assert.equal(feedback.kind, "range_shrunk");
  assert.match(feedback.hint, /개수형 파라미터가 바뀌며\(shelves 2→1\)/);
});

test("재계산이 실패해 줄어든 범위는 recompute_failed로 알리고 슬라이더가 넘으면 좁히라고 한다", () => {
  const bundle = structuredClone(shellPointRecording);
  const [reduction] = bundle.sweeps.find((s) => s.parameter === "body_d")!.reductions!;
  Object.assign(reduction, { reason: "recompute_failed", removed_faces: [], removed_edges: [], added_edges: [] });

  const [upload] = uploadRangeFeedback(bundle);
  const [feedback] = verifyRange(bodyDepth, bundle);

  assert.deepEqual([upload.kind, upload.part], ["recompute_failed", ""]);
  assert.match(upload.hint, /body_d의 스윕 범위는 225에서 Fusion이 재계산하지 못했습니다\. min가 337\.5까지 줄었습니다/);
  assert.equal(feedback.path, "sliders[0].min");
  assert.match(feedback.hint, /body_d의 min 값을 337\.5 이상으로 좁히세요/);
});

test("면은 그대로이고 모서리만 바뀌어 줄어든 범위는 바뀐 모서리를 힌트에 적는다", () => {
  const bundle = structuredClone(shellPointRecording);
  const [reduction] = bundle.sweeps.find((s) => s.parameter === "body_d")!.reductions!;
  Object.assign(reduction, { removed_faces: [], removed_edges: [{ body: "DrawerBox", name: "F5:side:l1|F5:top" }], added_edges: [] });

  const [feedback] = uploadRangeFeedback(bundle);

  assert.equal(feedback.part, "DrawerBox");
  assert.match(feedback.hint, /바뀐 모서리: DrawerBox F5:side:l1\|F5:top/);
});

// 위상 묶음(ADR-0005): 칸막이 선반 합성 녹화본을 바꿔 만든다.

/** 칸막이 선반의 전체 폭 스윕에서 위상 묶음이 상한을 넘어 4칸 묶음을 뺀 것처럼 바꾼 사본 */
function withGroupLimit() {
  const bundle = structuredClone(shelfRecording);
  const width = bundle.sweeps.find((s) => s.parameter === "shelf_w")!;
  const dropped = width.groups!.pop()!;
  width.range.max = 1199.927;
  width.reductions = [
    {
      side: "max",
      at: 1237.5,
      reason: "topology_group_limit",
      removed_faces: [],
      added_faces: dropped.baseline.faces.filter((f) => f.body === "Body1 (2)").map(({ body, name }) => ({ body, name })),
      removed_edges: [],
      added_edges: [],
      counts: { bays: [3, 4] },
    },
  ];
  return bundle;
}

test("위상 묶음이 상한을 넘어 줄어든 범위는 topology_group_limit으로 알리고 범위를 줄이라고 한다", () => {
  const [upload] = uploadRangeFeedback(withGroupLimit());
  const [feedback, ...rest] = verifyRange(shelfSpec, withGroupLimit());

  assert.equal(upload.kind, "topology_group_limit");
  assert.equal(upload.part, "Body1 (2)");
  assert.match(upload.hint, /위상 묶음이 4개를 넘/);
  assert.equal(rest.length, 0);
  assert.equal(feedback.path, "sliders[0].max");
  assert.deepEqual(feedback.expected, { max: 1199.927 });
  assert.match(feedback.hint, /shelf_w의 max 값을 1199.927 이하로 좁히세요/);
});

/** 칸막이 선반 4칸 묶음 안의 전체 깊이 단독 스윕이 max 쪽에서 줄어든 것처럼 바꾼 사본 */
function withGroupReduction() {
  const bundle = structuredClone(shelfRecording);
  const group = bundle.sweeps.find((s) => s.parameter === "shelf_w")!.groups![1];
  const depth = group.sweeps.find((s) => s.parameter === "shelf_d")!;
  depth.range.max = 375;
  depth.reductions = [
    {
      side: "max",
      at: 412.5,
      reason: "modeling_error_suspected",
      removed_faces: [{ body: "Carcass", name: "F2:+y" }],
      added_faces: [],
      removed_edges: [],
      added_edges: [],
      counts: {},
    },
  ];
  return { bundle, anchor: group.anchor };
}

test("위상 묶음 안 단독 스윕의 범위 축소도 묶음과 함께 알리고, 슬라이더 범위가 그 묶음에 닿을 때만 좁히라고 한다", () => {
  const { bundle, anchor } = withGroupReduction();

  const [upload] = uploadRangeFeedback(bundle);
  assert.equal(upload.slider, "shelf_d");
  assert.equal(upload.part, "Carcass");
  assert.match(upload.hint, new RegExp(`shelf_w=${anchor} 위상 묶음에서 shelf_d의 스윕 범위는 412\.5에서`));

  const [feedback, ...rest] = verifyRange(shelfSpec, bundle);
  assert.equal(rest.length, 0);
  assert.equal(feedback.path, "sliders[1].max");
  assert.deepEqual(feedback.expected, { max: 375 });
  assert.deepEqual((feedback.measured as { values: object }).values, { shelf_w: anchor });
  assert.match(feedback.hint, /shelf_d의 max 값을 375 이하로 좁히세요/);

  const narrow = { ...shelfSpec, sliders: [{ ...shelfSpec.sliders[0], max: 1100 }, shelfSpec.sliders[1]] };
  assert.deepEqual(verifyRange(narrow, bundle), []);
});
