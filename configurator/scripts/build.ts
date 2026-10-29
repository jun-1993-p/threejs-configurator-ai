// 구성기 결과물 만들기: 고정 코어 번들, 명세, 스윕 데이터, 쇼핑몰에 붙여 넣을 div.
// 실행: node scripts/build.ts <명세.json> <업로드 묶음.json> <출력 폴더>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Spec, SweepData } from "../src/engine.ts";
import { assembleProduct } from "../pipeline/assemble.ts";

export async function writeProduct(spec: Spec, bundle: SweepData, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(await assembleProduct(spec, bundle))) {
    writeFileSync(join(outDir, name), content);
  }
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
