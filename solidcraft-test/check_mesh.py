"""SolidCraft OBJ 단계별 메쉬 일관성 검사.

사용: python check_mesh.py  (obj/ 폴더의 body_d_*, d6_* 시리즈를 검사)
결과는 표준 출력과 mesh_check.json 에 남긴다.
"""
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
OBJ_DIR = HERE / "obj"
WELD_TOL = 1e-6  # mm, 부동소수 오차로 갈라진 같은 점을 합칠 때 쓰는 허용치
MOVE_TOL = 1e-6  # mm, 이보다 작은 이동은 0으로 본다

SERIES = {
    # 시리즈 이름: (파일 접두사, 변형 축 이름, 축 번호)
    "body_d": ("body_d_", "Y(깊이)", 1),
    "d6": ("d6_", "Z(높이)", 2),
}


def parse_obj(path):
    """객체별 꼭짓점 목록과 면(꼭짓점 번호 3개, 0부터) 목록을 돌려준다."""
    objects = {}
    order = []
    cur = None
    verts = []  # 파일 전체 꼭짓점 (OBJ 번호는 전역)
    for line in path.read_text().splitlines():
        if line.startswith("o "):
            cur = line[2:].strip()
            objects[cur] = {"v": [], "f": []}
            order.append(cur)
        elif line.startswith("v "):
            p = tuple(float(x) for x in line.split()[1:4])
            verts.append(p)
            objects[cur]["v"].append(len(verts) - 1)
        elif line.startswith("f "):
            idx = tuple(int(tok.split("/")[0]) - 1 for tok in line.split()[1:])
            objects[cur]["f"].append(idx)
    return verts, objects, order


def weld(verts, tol=WELD_TOL):
    """허용치 안의 점을 하나로 합친다. 원래 번호 -> 새 번호, 새 꼭짓점 목록."""
    remap = {}
    out = []
    for i, p in enumerate(verts):
        for j, q in enumerate(out):
            if all(abs(a - b) <= tol for a, b in zip(p, q)):
                remap[i] = j
                break
        else:
            remap[i] = len(out)
            out.append(p)
    return remap, out


def rank_labels(verts, objs, order):
    """꼭짓점마다 (객체, x순위, y순위, z순위) 꼬리표를 붙인다.

    상자 형태는 치수가 바뀌어도 좌표의 크기 순서가 유지되므로, 이 꼬리표는
    단계가 달라도 '같은 역할의 점'을 가리킨다. 순서가 바뀐 꼭짓점을 맞춰 보는 용도.
    """
    labels = {}
    for o in order:
        idx = objs[o]["v"]
        for k in range(3):
            vals = sorted({round(verts[i][k], 4) for i in idx})
            for i in idx:
                labels.setdefault(i, [o, None, None, None])[k + 1] = vals.index(round(verts[i][k], 4))
    return {i: tuple(l) for i, l in labels.items()}


def step_value(path, prefix):
    m = re.match(re.escape(prefix) + r"(\d+)_([\d.]+)\.obj$", path.name)
    return int(m.group(1)), float(m.group(2))


def displacement_report(base, other, axis):
    """같은 번호 꼭짓점끼리 이동량을 비교한다."""
    if len(base) != len(other):
        return None
    off_axis = 0.0
    on_axis = set()
    for p, q in zip(base, other):
        d = [b - a for a, b in zip(p, q)]
        for k in range(3):
            if k != axis:
                off_axis = max(off_axis, abs(d[k]))
        if abs(d[axis]) > MOVE_TOL:
            on_axis.add(round(d[axis], 6))
    return {"max_off_axis_mm": off_axis, "distinct_axis_moves_mm": sorted(on_axis)}


def check_series(name, prefix, axis_name, axis):
    files = sorted(OBJ_DIR.glob(prefix + "*.obj"), key=lambda p: step_value(p, prefix)[0])
    steps = []
    for p in files:
        n, val = step_value(p, prefix)
        verts, objs, order = parse_obj(p)
        faces = [f for o in order for f in objs[o]["f"]]
        remap, welded = weld(verts)
        labels = rank_labels(verts, objs, order)
        label_pos = {}
        for i, lab in labels.items():
            label_pos.setdefault(lab, verts[i])
        steps.append({
            "faces_label": [tuple(labels[i] for i in f) for f in faces],
            "label_pos": label_pos,
            "file": p.name, "step": n, "value": val,
            "sha1": hashlib.sha1(p.read_bytes()).hexdigest()[:10],
            "objects": order,
            "raw_vertices": len(verts), "faces": len(faces),
            "per_object_raw": {o: len(objs[o]["v"]) for o in order},
            "welded_vertices": len(welded),
            "verts": verts, "welded": welded,
            "faces_raw": faces,
            "faces_welded": [tuple(remap[i] for i in f) for f in faces],
        })

    base = next(s for s in steps if s["step"] == 3)  # 기본값(100%) 단계
    rows = []
    for s in steps:
        row = {k: s[k] for k in ("file", "step", "value", "sha1", "raw_vertices",
                                  "welded_vertices", "faces", "per_object_raw")}
        row["same_raw_count"] = s["raw_vertices"] == base["raw_vertices"]
        row["same_face_count"] = s["faces"] == base["faces"]
        row["same_raw_face_indices"] = s["faces_raw"] == base["faces_raw"]
        row["same_welded_face_indices"] = s["faces_welded"] == base["faces_welded"]
        row["raw_disp"] = displacement_report(base["verts"], s["verts"], axis)
        row["welded_disp"] = (displacement_report(base["welded"], s["welded"], axis)
                              if row["same_welded_face_indices"] else None)
        # 꼬리표로 다시 맞춘 뒤: 삼각형 순서/집합이 같은지, 같은 꼬리표끼리 이동 방향
        row["label_count"] = len(s["label_pos"])
        row["same_label_faces_ordered"] = s["faces_label"] == base["faces_label"]
        tri_set = lambda fl: {frozenset(t) for t in fl}
        row["same_label_tri_set"] = tri_set(s["faces_label"]) == tri_set(base["faces_label"])
        row["tri_only_here"] = len(tri_set(s["faces_label"]) - tri_set(base["faces_label"]))
        if s["label_pos"].keys() == base["label_pos"].keys():
            keys = sorted(base["label_pos"])
            row["label_disp"] = displacement_report(
                [base["label_pos"][k] for k in keys], [s["label_pos"][k] for k in keys], axis)
        else:
            row["label_disp"] = None
        rows.append(row)
    return {"series": name, "axis": axis_name, "base_value": base["value"], "rows": rows}


def main():
    results = [check_series(n, *cfg) for n, cfg in SERIES.items()]
    (HERE / "mesh_check.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    for r in results:
        print(f"== {r['series']}  (축 {r['axis']}, 기본값 {r['base_value']})")
        for row in r["rows"]:
            print(f"  step{row['step']} v={row['value']:>6}  raw_v={row['raw_vertices']:>3}"
                  f" welded_v={row['welded_vertices']:>3} f={row['faces']}"
                  f" raw_idx_same={row['same_raw_face_indices']}"
                  f" welded_idx_same={row['same_welded_face_indices']}"
                  f" sha1={row['sha1']} per_obj={row['per_object_raw']}")
            if row["raw_disp"]:
                print(f"      raw 이동: {row['raw_disp']}")
            if row["welded_disp"]:
                print(f"      welded 이동: {row['welded_disp']}")
            print(f"      꼬리표 {row['label_count']}개, 삼각형 순서 같음={row['same_label_faces_ordered']},"
                  f" 삼각형 집합 같음={row['same_label_tri_set']} (기본값에 없는 삼각형 {row['tri_only_here']}개)")
            if row["label_disp"]:
                print(f"      꼬리표 이동: {row['label_disp']}")


if __name__ == "__main__":
    main()
