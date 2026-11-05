// 조립: 고정 코어 번들, 명세, 스윕 데이터, 스타일 선택, 쇼핑몰에 붙여 넣을 div를 결과물 파일로 만든다.
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { findPair, inGroup, reaches, type CrossSample, type SampleFace, type Spec, type Sweep, type SweepData } from "../src/engine.ts";
import type { Style } from "../src/style.ts";

const CORE = fileURLToPath(new URL("../src/core.ts", import.meta.url));

/** 고정 코어를 브라우저용 번들 하나로 묶는다. 전역 `Configurator`로 mount·createMorph를 내보낸다. */
async function buildCore(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [CORE],
    write: false,
    bundle: true,
    format: "iife",
    globalName: "Configurator",
    target: "es2020",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}

/** 엔진이 읽는 면 필드만 남긴다 */
const engineFaces = (faces: SampleFace[]) => faces.map(({ body, name, points }) => ({ body, name, points }));

/** 엔진이 읽는 부품·기준 형상 필드만 남긴다 */
const engineParts = (parts: SweepData["parts"]) => parts.map(({ name, faces }) => ({ name, faces }));
const engineBaseline = (baseline: SweepData["baseline"]) => ({
  faces: baseline.faces.map(({ body, name, points, triangles }) => ({ body, name, points, triangles })),
});

/**
 * 명세의 슬라이더가 쓰는 단독 스윕만, 엔진이 읽는 필드만 남긴다. 위상 묶음은 슬라이더 범위가 닿는 것만 남기고,
 * 묶음 안의 단독 스윕도 같은 방법으로 줄인다. 위상 묶음은 명세가 아니라 스윕 데이터에 담긴다(ADR-0005).
 */
function engineSweeps(spec: Spec, sweeps: Sweep[]): Sweep[] {
  return sweeps.flatMap(({ parameter, samples, groups = [] }) => {
    const slider = spec.sliders.find((s) => s.id === parameter);
    if (!slider) return [];
    const reached = groups.filter((g) => reaches(slider, g));
    // 범위가 닿지 않아 뺀 위상 묶음 안의 샘플도 뺀다. 남기면 엔진이 다른 묶음의 형상을 기본 묶음의 샘플로 읽는다.
    const kept = samples.filter((s) => !groups.some((g) => !reached.includes(g) && inGroup(g, s.value)));
    return [
      {
        parameter,
        samples: kept.map(({ value, status, faces }) => ({ value, status, faces: engineFaces(faces) })),
        ...(reached.length === 0
          ? {}
          : {
              groups: reached.map(({ range, anchor, counts, parts, baseline, sweeps: inner }) => ({
                range,
                anchor,
                counts,
                parts: engineParts(parts),
                baseline: engineBaseline(baseline),
                sweeps: engineSweeps(spec, inner),
              })),
            }),
      },
    ];
  });
}

/** 교차 검증 샘플 형식에서 엔진이 읽는 필드만 남긴다 */
const engineSamples = (samples: CrossSample[]) => samples.map(({ values, status, faces }) => ({ values, status, faces: engineFaces(faces) }));

/** 업로드 묶음과 격자 보강·두께 후보 형상에서 명세가 쓰는 부분만 남긴다. 형식은 그대로라 엔진이 바로 읽는다. */
function sweepDataFor(spec: Spec, bundle: SweepData): SweepData {
  // 격자 보강 쌍은 두 슬라이더, 또는 두께 쌍(두께 선택과 슬라이더)이다
  const grids = (bundle.grids ?? []).filter((g) => findPair(spec, g.parameters) !== undefined);
  const thickness = spec.thickness.length === 0 ? [] : (bundle.thickness ?? []);
  return {
    parts: engineParts(bundle.parts),
    baseline: engineBaseline(bundle.baseline),
    sweeps: engineSweeps(spec, bundle.sweeps),
    ...(grids.length === 0
      ? {}
      : {
          grids: grids.map(({ parameters, samples }) => ({ parameters, samples: engineSamples(samples) })),
        }),
    ...(thickness.length === 0 ? {} : { thickness: engineSamples(thickness) }),
  };
}

const SNIPPET = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>구성기</title>
</head>
<body>
<!-- 쇼핑몰 페이지에는 아래 두 줄만 붙인다. 명세와 스윕 데이터, 스타일 선택은 div의 주소에서 불러온다. -->
<div data-configurator data-spec="spec.json" data-sweeps="sweeps.json" data-style="style.json"></div>
<script src="configurator.js"></script>
</body>
</html>
`;

/** 결과물 파일 이름과 내용. 쇼핑몰에는 이 파일들을 그대로 올린다. */
export type ProductFiles = Record<"configurator.js" | "spec.json" | "sweeps.json" | "style.json" | "index.html", string>;

/**
 * 최종 승인에서 고친 명세로 결과물의 명세와 스윕 데이터를 다시 만든다. 결과물의 스윕 데이터는 이미 업로드 묶음 형식이라 같은 방법으로 다시 거르고,
 * 좁힌 범위가 닿지 않는 위상 묶음은 빠진다. 고정 코어 번들과 스타일 선택은 그대로다.
 */
export function withApprovedSpec(files: ProductFiles, spec: Spec): ProductFiles {
  return { ...files, "spec.json": JSON.stringify(spec, null, 2), "sweeps.json": JSON.stringify(sweepDataFor(spec, JSON.parse(files["sweeps.json"]))) };
}

/**
 * 고정 코어 번들과 명세·스윕 데이터·스타일 선택·붙여 넣을 div를 메모리에서 만든다. bundle.grids·thickness는 검증 중에 받은 격자 보강·두께 후보 형상이다.
 * style은 UI 스타일 목록에서 고른 스타일 그대로다.
 */
export async function assembleProduct(spec: Spec, bundle: SweepData, style: Style): Promise<ProductFiles> {
  return {
    "configurator.js": await buildCore(),
    "spec.json": JSON.stringify(spec, null, 2),
    "sweeps.json": JSON.stringify(sweepDataFor(spec, bundle)),
    "style.json": JSON.stringify(style, null, 2),
    "index.html": SNIPPET,
  };
}
