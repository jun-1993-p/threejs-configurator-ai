// 고정 코어: 명세와 스윕 데이터, 스타일 선택만으로 div 하나 안에 구성기를 만든다. 상품마다 바뀌지 않는다(ADR-0001).
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { createMorph, type MorphShape, type Spec, type SweepData, type ThicknessChoice } from "./engine.ts";
import type { SliderShape, Style } from "./style.ts";

// 검증기가 구성기와 같은 엔진을 쓰도록 번들 전역(Configurator)으로도 내보낸다
export { createMorph };

export interface Configurator {
  /** 지금 슬라이더 값과 두께 선택 값(두께 선택은 묶인 파라미터마다 같은 값) */
  readonly values: Record<string, number>;
  /** 슬라이더 값은 범위 안으로 맞추고, 두께 선택(묶인 파라미터 중 아무 이름)은 두께 후보 중 하나여야 한다 */
  set(id: string, value: number): void;
  dispose(): void;
}

/** 슬라이더 모양마다 트랙 두께·손잡이 크기(px)와 둥근지. 스타일 선택은 모양 이름만 고르고 CSS는 여기서만 만든다. */
const SLIDER_SHAPE_SIZES: Record<SliderShape, { track: number; thumb: number; round: boolean }> = {
  thin: { track: 4, thumb: 16, round: true },
  bold: { track: 10, thumb: 22, round: true },
  square: { track: 6, thumb: 16, round: false },
};

const sliderClass = (shape: SliderShape) => `configurator-slider-${shape}`;

/** 슬라이더 모양의 CSS. 색은 구성기 div의 --configurator-accent를 따른다. */
function sliderCss(shape: SliderShape): string {
  const { track, thumb, round } = SLIDER_SHAPE_SIZES[shape];
  const selector = `.${sliderClass(shape)}`;
  // color-mix를 모르는 브라우저는 앞의 회색 트랙을 쓴다
  const trackRule = `height:${track}px;border-radius:${round ? `${track / 2}px` : "0"};background:#8888;background:color-mix(in srgb,var(--configurator-accent) 25%,transparent)`;
  const thumbRule = `width:${thumb}px;height:${thumb}px;border:none;border-radius:${round ? "50%" : "0"};background:var(--configurator-accent)`;
  return [
    `${selector}{-webkit-appearance:none;appearance:none;width:100%;height:${thumb}px;margin:0;background:transparent}`,
    `${selector}::-webkit-slider-runnable-track{${trackRule}}`,
    `${selector}::-moz-range-track{${trackRule}}`,
    `${selector}::-webkit-slider-thumb{-webkit-appearance:none;${thumbRule};margin-top:${(track - thumb) / 2}px}`,
    `${selector}::-moz-range-thumb{${thumbRule}}`,
  ].join("\n");
}

/** 명세의 Fusion 축 이름("X", "-Y" 등)을 단위 벡터로 바꾼다 */
function axisVector(axis: string): THREE.Vector3 {
  const sign = axis.startsWith("-") ? -1 : 1;
  const v = new THREE.Vector3();
  v.setComponent("XYZ".indexOf(axis.replace(/^[+-]/, "")), sign);
  return v;
}

export function mount(container: HTMLElement, spec: Spec, sweeps: SweepData, style: Style): Configurator {
  const morph = createMorph(spec, sweeps);
  const values: Record<string, number> = Object.fromEntries([
    ...spec.sliders.map((s) => [s.id, s.default]),
    ...spec.thickness.flatMap((t) => t.ids.map((id) => [id, t.default])),
  ]);

  container.replaceChildren();
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "12px",
    fontFamily: style.font,
    color: style.colors.text,
    background: style.colors.background,
  });
  container.style.setProperty("--configurator-accent", style.colors.accent);
  const sheet = document.createElement("style");
  sheet.textContent = sliderCss(style.slider);
  const view = document.createElement("div");
  Object.assign(view.style, { position: "relative", width: "100%", aspectRatio: "4 / 3" });
  const panel = document.createElement("div");
  Object.assign(panel.style, { display: "flex", flexDirection: "column", gap: "8px" });
  container.append(sheet, view, panel);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(style.colors.background);
  Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
  view.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(sun);

  // 부품마다 메쉬 하나. 꼭짓점 위치는 모든 부품이 한 버퍼를 같이 쓴다.
  // 위상 묶음이 바뀌면(칸막이가 생기거나 사라지면) 페이드 없이 메쉬를 새 면 구성으로 바로 바꾼다(ADR-0005).
  // 부품 색은 부품 이름마다 처음 본 순서로 정해, 묶음이 바뀌어도 같은 부품은 같은 색이다.
  const partColors = new Map<string, string>();
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
      if (!partColors.has(part)) partColors.set(part, style.colors.parts[partColors.size % style.colors.parts.length]);
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
    Object.assign(input, { type: "range", className: sliderClass(style.slider), min: String(slider.min), max: String(slider.max), step: String(slider.step) });
    input.value = String(slider.default);
    const output = document.createElement("output");
    output.style.textAlign = "right";
    output.textContent = `${slider.default} ${slider.unit}`;
    input.addEventListener("input", () => configurator.set(slider.id, Number(input.value)));
    row.append(name, input, output);
    panel.append(row);
    inputs.set(slider.id, { input, output });
  }

  // 두께 선택 슬롯: 사이 값이 없으므로 슬라이더가 아니라 두께 후보 중 하나를 고른다(ADR-0010)
  const slots = new Map<ThicknessChoice, HTMLSelectElement>();
  for (const choice of spec.thickness) {
    const row = document.createElement("label");
    Object.assign(row.style, { display: "grid", gridTemplateColumns: "6em 1fr", alignItems: "center", gap: "8px" });
    const name = document.createElement("span");
    name.textContent = choice.name;
    const select = document.createElement("select");
    Object.assign(select.style, { font: "inherit", accentColor: style.colors.accent });
    for (const option of choice.options) select.add(new Option(`${option} mm`, String(option), false, option === choice.default));
    select.addEventListener("change", () => configurator.set(choice.ids[0], Number(select.value)));
    row.append(name, select);
    panel.append(row);
    slots.set(choice, select);
  }

  const configurator: Configurator = {
    values,
    set(id, value) {
      const choice = spec.thickness.find((t) => t.ids.includes(id));
      if (choice) {
        if (!choice.options.includes(value)) throw new Error(`두께 선택 ${choice.name}에 ${value} mm 후보가 없습니다`);
        for (const board of choice.ids) values[board] = value;
        slots.get(choice)!.value = String(value);
        update();
        return;
      }
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

/** 페이지의 `<div data-configurator data-spec=… data-sweeps=… data-style=…>`마다 구성기를 붙인다 */
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
      const [spec, sweeps, style] = await Promise.all([load("data-spec"), load("data-sweeps"), load("data-style")]);
      return mount(div, spec, sweeps, style);
    }),
  );
}

// 번들을 Node 등 DOM 없는 곳에서 불러오면 엔진만 쓴다
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void mountAll());
  else void mountAll();
}
