// 줄어든 스윕 범위: 서랍 속 비우기 면 지정점이 면 밖으로 나가는 서랍장 합성 녹화본으로 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadRangeFeedback, verifyRange } from "../pipeline/verify-range.ts";
import { depthSpec, drawerSpec, shellPointRecording } from "./recording.ts";

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

test("면은 그대로이고 모서리만 바뀌어 줄어든 범위는 바뀐 모서리를 힌트에 적는다", () => {
  const bundle = structuredClone(shellPointRecording);
  const [reduction] = bundle.sweeps.find((s) => s.parameter === "body_d")!.reductions!;
  Object.assign(reduction, { removed_faces: [], removed_edges: [{ body: "DrawerBox", name: "F5:side:l1|F5:top" }], added_edges: [] });

  const [feedback] = uploadRangeFeedback(bundle);

  assert.equal(feedback.part, "DrawerBox");
  assert.match(feedback.hint, /바뀐 모서리: DrawerBox F5:side:l1\|F5:top/);
});
