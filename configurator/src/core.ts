// 고정 코어: 명세와 스윕 데이터만으로 div 하나 안에 구성기를 만든다. 상품마다 바뀌지 않는다(ADR-0001).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { createMorph, type MorphShape, type Spec, type SweepData } from "./engine.ts";

// 검증기가 구성기와 같은 엔진을 쓰도록 번들 전역(Configurator)으로도 내보낸다
export { createMorph };

export interface Configurator {
  /** 지금 슬라이더 값 */
  readonly values: Record<string, number>;
  set(id: string, value: number): void;
  dispose(): void;
}

// 부품마다 돌려 쓰는 색. 스타일 선택(티켓 18)이 들어오면 그쪽에서 정한다.
const PART_COLORS = [0xd8c3a5, 0xa47551, 0x8e8d8a, 0xc9ada1, 0x7d8a6a];

/** 명세의 Fusion 축 이름("X", "-Y" 등)을 단위 벡터로 바꾼다 */
function axisVector(axis: string): THREE.Vector3 {
  const sign = axis.startsWith("-") ? -1 : 1;
  const v = new THREE.Vector3();
  v.setComponent("XYZ".indexOf(axis.replace(/^[+-]/, "")), sign);
  return v;
}

export function mount(container: HTMLElement, spec: Spec, sweeps: SweepData): Configurator {
  const morph = createMorph(spec, sweeps);
  const values: Record<string, number> = Object.fromEntries(spec.sliders.map((s) => [s.id, s.default]));

  container.replaceChildren();
  Object.assign(container.style, { display: "flex", flexDirection: "column", gap: "12px", fontFamily: "sans-serif" });
  const view = document.createElement("div");
  Object.assign(view.style, { position: "relative", width: "100%", aspectRatio: "4 / 3" });
  const panel = document.createElement("div");
  Object.assign(panel.style, { display: "flex", flexDirection: "column", gap: "8px" });
  container.append(view, panel);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0xf4f4f2);
  Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
  view.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(sun);

  // 부품마다 메쉬 하나. 꼭짓점 위치는 모든 부품이 한 버퍼를 같이 쓴다.
  // 위상 묶음이 바뀌면(칸막이가 생기거나 사라지면) 페이드 없이 메쉬를 새 면 구성으로 바로 바꾼다(ADR-0005).
  // 부품 색은 부품 이름마다 처음 본 순서로 정해, 묶음이 바뀌어도 같은 부품은 같은 색이다.
  const partColors = new Map<string, number>();
  let shown: { faces: MorphShape["faces"]; position: THREE.BufferAttribute; meshes: THREE.Mesh[] };
  const show = (shape: MorphShape) => {
    const position = new THREE.BufferAttribute(new Float32Array(shape.positions), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const parts = [...new Set(shape.faces.map((f) => f.part))];
    const partOfVertex = new Uint32Array(position.count);
    for (const face of shape.faces) partOfVertex.fill(parts.indexOf(face.part), face.start, face.start + face.count);
    const meshes = parts.map((part, n) => {
      const index: number[] = [];
      const t = shape.triangles;
      for (let i = 0; i < t.length; i += 3) if (partOfVertex[t[i]] === n) index.push(t[i], t[i + 1], t[i + 2]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", position);
      geometry.setIndex(index);
      geometry.computeVertexNormals();
      if (!partColors.has(part)) partColors.set(part, PART_COLORS[partColors.size % PART_COLORS.length]);
      const material = new THREE.MeshStandardMaterial({ color: partColors.get(part), roughness: 0.8, side: THREE.DoubleSide });
      return new THREE.Mesh(geometry, material);
    });
    if (shown) {
      for (const mesh of shown.meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }
    scene.add(...meshes);
    shown = { faces: shape.faces, position, meshes };
  };
  show(morph.shape(values));
  const geometries = shown!.meshes.map((m) => m.geometry);

  // 카메라는 기본 형상을 정면에서 비스듬히 위로 본다
  const up = axisVector(spec.axes.H);
  const front = axisVector(spec.front);
  const side = new THREE.Vector3().crossVectors(up, front);
  const box = new THREE.Box3();
  for (const g of geometries) {
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, radius / 100, radius * 100);
  camera.up.copy(up);
  const direction = front.clone().addScaledVector(side, -0.6).addScaledVector(up, 0.5).normalize();
  camera.position.copy(center).addScaledVector(direction, radius * 3);
  sun.position.copy(camera.position).addScaledVector(side, radius * 2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;

  const render = () => renderer.render(scene, camera);
  controls.addEventListener("change", render);
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    controls.update();
  };
  tick();

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = view;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(view);

  const update = () => {
    const shape = morph.shape(values);
    if (shape.faces !== shown.faces) {
      show(shape);
    } else {
      (shown.position.array as Float32Array).set(shape.positions);
      shown.position.needsUpdate = true;
      for (const mesh of shown.meshes) mesh.geometry.computeVertexNormals();
    }
    render();
  };

  const inputs = new Map<string, { input: HTMLInputElement; output: HTMLOutputElement }>();
  for (const slider of spec.sliders) {
    const row = document.createElement("label");
    Object.assign(row.style, { display: "grid", gridTemplateColumns: "6em 1fr 5em", alignItems: "center", gap: "8px" });
    const name = document.createElement("span");
    name.textContent = slider.name;
    const input = document.createElement("input");
    Object.assign(input, { type: "range", min: String(slider.min), max: String(slider.max), step: String(slider.step) });
    input.value = String(slider.default);
    const output = document.createElement("output");
    output.style.textAlign = "right";
    output.textContent = `${slider.default} ${slider.unit}`;
    input.addEventListener("input", () => configurator.set(slider.id, Number(input.value)));
    row.append(name, input, output);
    panel.append(row);
    inputs.set(slider.id, { input, output });
  }

  const configurator: Configurator = {
    values,
    set(id, value) {
      const slider = spec.sliders.find((s) => s.id === id);
      const ui = inputs.get(id);
      if (!slider || !ui) throw new Error(`명세에 슬라이더 ${id}가 없습니다`);
      values[id] = Math.min(slider.max, Math.max(slider.min, value));
      ui.input.value = String(values[id]);
      ui.output.textContent = `${values[id]} ${slider.unit}`;
      update();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      container.replaceChildren();
    },
  };
  return configurator;
}

/** 페이지의 `<div data-configurator data-spec=… data-sweeps=…>`마다 구성기를 붙인다 */
export async function mountAll(root: ParentNode = document): Promise<Configurator[]> {
  const divs = [...root.querySelectorAll<HTMLElement>("[data-configurator]")];
  return Promise.all(
    divs.map(async (div) => {
      const load = async (attr: string) => {
        const url = div.getAttribute(attr);
        if (!url) throw new Error(`구성기 div에 ${attr} 속성이 없습니다`);
        const response = await fetch(new URL(url, document.baseURI));
        if (!response.ok) throw new Error(`${url}을 불러오지 못했습니다(${response.status})`);
        return response.json();
      };
      const [spec, sweeps] = await Promise.all([load("data-spec"), load("data-sweeps")]);
      return mount(div, spec, sweeps);
    }),
  );
}

// 번들을 Node 등 DOM 없는 곳에서 불러오면 엔진만 쓴다
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void mountAll());
  else void mountAll();
}
