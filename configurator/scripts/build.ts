// 구성기 결과물 만들기: 고정 코어 번들, 명세, 스윕 데이터, 쇼핑몰에 붙여 넣을 div.
// 실행: node scripts/build.ts <명세.json> <업로드 묶음.json> <출력 폴더>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import type { Spec, SweepData } from "../src/engine.ts";

const CORE = fileURLToPath(new URL("../src/core.ts", import.meta.url));

/** 고정 코어를 브라우저용 번들 하나로 묶는다. 전역 `Configurator`로 mount·createMorph를 내보낸다. */
export async function buildCore(outfile: string): Promise<void> {
  await esbuild.build({
    entryPoints: [CORE],
    outfile,
    bundle: true,
    format: "iife",
    globalName: "Configurator",
    target: "es2020",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
}

/** 업로드 묶음에서 명세의 슬라이더가 쓰는 부분만 남긴다. 형식은 그대로라 엔진이 바로 읽는다. */
export function sweepDataFor(spec: Spec, bundle: SweepData): SweepData {
  const ids = new Set(spec.sliders.map((s) => s.id));
  return {
    parts: bundle.parts.map(({ name, faces }) => ({ name, faces })),
    baseline: {
      faces: bundle.baseline.faces.map(({ body, name, points, triangles }) => ({ body, name, points, triangles })),
    },
    sweeps: bundle.sweeps
      .filter((s) => ids.has(s.parameter))
      .map(({ parameter, samples }) => ({
        parameter,
        samples: samples.map(({ value, status, faces }) => ({
          value,
          status,
          faces: faces.map(({ body, name, points }) => ({ body, name, points })),
        })),
      })),
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
<!-- 쇼핑몰 페이지에는 아래 두 줄만 붙인다. 명세와 스윕 데이터는 div의 주소에서 불러온다. -->
<div data-configurator data-spec="spec.json" data-sweeps="sweeps.json"></div>
<script src="configurator.js"></script>
</body>
</html>
`;

export async function writeProduct(spec: Spec, bundle: SweepData, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await buildCore(join(outDir, "configurator.js"));
  writeFileSync(join(outDir, "spec.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(outDir, "sweeps.json"), JSON.stringify(sweepDataFor(spec, bundle)));
  writeFileSync(join(outDir, "index.html"), SNIPPET);
}

if (import.meta.main) {
  const [specPath, bundlePath, outDir] = process.argv.slice(2);
  if (!specPath || !bundlePath || !outDir) {
    console.error("사용법: node scripts/build.ts <명세.json> <업로드 묶음.json> <출력 폴더>");
    process.exit(2);
  }
  const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
  await writeProduct(read(specPath), read(bundlePath), outDir);
  console.log(`구성기 결과물: ${outDir}`);
}
