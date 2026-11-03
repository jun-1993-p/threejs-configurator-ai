// 업로드 묶음의 단독 스윕을 하나씩 도는 도우미: 기본 묶음의 단독 스윕과 위상 묶음 안의 단독 스윕(ADR-0005).
// 범위 축소(verify-range.ts)와 보간 실패·부피 튐(verify-sweep.ts)이 같이 쓴다.
import type { BundleSweep, UploadBundle } from "./upload-bundle.ts";

type Range = { min: number; max: number };

/**
 * 단독 스윕 하나와 그 스윕의 부품. 위상 묶음 안의 단독 스윕이면 group에 그 묶음의 파라미터와 기준 값이 있다.
 * 부품은 그 스윕의 기준 형상(기본 형상 또는 묶음 기준 형상) 면으로 정해진다.
 * groups는 기본 묶음의 단독 스윕이 나뉜 위상 묶음의 범위다(위상 묶음 안의 단독 스윕은 다시 나뉘지 않아 빈 목록).
 */
export interface Scope {
  sweep: BundleSweep;
  parts: UploadBundle["parts"];
  faces: UploadBundle["baseline"]["faces"];
  group?: { parameter: string; anchor: number; range: Range };
  groups: Range[];
}

/** 기본 묶음의 단독 스윕과 위상 묶음 안의 단독 스윕 */
export function scopes(bundle: UploadBundle): Scope[] {
  return bundle.sweeps.flatMap((sweep) => [
    { sweep, parts: bundle.parts, faces: bundle.baseline.faces, groups: (sweep.groups ?? []).map((g) => g.range) },
    ...(sweep.groups ?? []).flatMap((g) =>
      g.sweeps.map((inner) => ({
        sweep: inner,
        parts: g.parts,
        faces: g.baseline.faces,
        group: { parameter: sweep.parameter, anchor: g.anchor, range: g.range },
        groups: [],
      })),
    ),
  ]);
}

/** 바디가 속한 부품. 부품은 기준 형상 면으로 정해지므로 바디로 찾는다. 기준 형상에 없는 바디는 그 바디 이름이다. */
export function partOfBody({ parts, faces }: Scope, body: string | undefined): string {
  return parts.find((p) => p.faces.some((i) => faces[i].body === body))?.name ?? body ?? "";
}

/** 위상 묶음 안의 단독 스윕이면 힌트 앞에 그 묶음을 적는다: "shelf_w=1200.04 위상 묶음에서 " */
export const whereOf = ({ group }: Scope) => (group ? `${group.parameter}=${group.anchor} 위상 묶음에서 ` : "");
