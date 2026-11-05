// HTTP Fusion 연결 포트: 서버(server/app.py)에 추가 샘플 요청을 걸고, 애드인이 답할 때까지 요청 상태를 본다.
// 서버 자리에는 파이프라인 쪽 API(요청 걸기, 요청 상태 보기)를 흉내 내는 가짜 HTTP 서버를 띄운다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { httpFusion, type RequestStatus as Status } from "../pipeline/http-fusion.ts";
import type { SampleRequest } from "../pipeline/verify-spec.ts";

/** 요청 상태를 볼 때마다 states를 하나씩 내고, 마지막 것을 되풀이한다 */
async function fakeServer(states: Status[]) {
  const posted: { path: string; body: unknown }[] = [];
  const polled: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url === "/uploads/u1/sample-requests") {
        posted.push({ path: url, body: JSON.parse(raw) });
        res.writeHead(201).end(JSON.stringify({ id: `r${posted.length}` }));
      } else if (req.method === "GET" && url.startsWith("/uploads/u1/sample-requests/")) {
        polled.push(url);
        res.writeHead(200).end(JSON.stringify(states.length > 1 ? states.shift() : states[0]));
      } else {
        res.writeHead(404).end(JSON.stringify({ detail: "없음" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, posted, polled, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const request: SampleRequest = { kind: "cross", values: [{ body_w: 400, body_h: 500 }] };
const response = { samples: [{ values: { body_w: 400, body_h: 500 }, faces: [] }] };

test("추가 샘플 요청을 서버에 한 번 걸고 애드인이 답할 때까지 요청 상태를 본다", async () => {
  const server = await fakeServer([
    { status: "pending", fusion: "connected" },
    { status: "pending", fusion: "connected" },
    { status: "answered", fusion: "connected", response },
  ]);
  try {
    const answer = await httpFusion({ baseUrl: server.baseUrl, upload: "u1", pollMs: 1 }).requestSamples(request);

    assert.deepEqual(answer, { status: "answered", response });
    assert.deepEqual(server.posted, [{ path: "/uploads/u1/sample-requests", body: request }]);
    assert.deepEqual(server.polled, ["/uploads/u1/sample-requests/r1", "/uploads/u1/sample-requests/r1", "/uploads/u1/sample-requests/r1"]);
  } finally {
    await server.close();
  }
});

test("답을 기다리는 중에 애드인 연결이 끊기면 끊김을 알리고, 다시 연결된 뒤에는 같은 요청의 답을 받는다", async () => {
  const server = await fakeServer([
    { status: "pending", fusion: "disconnected" },
    { status: "pending", fusion: "disconnected" },
    { status: "pending", fusion: "connected" },
    { status: "answered", fusion: "connected", response },
  ]);
  try {
    const fusion = httpFusion({ baseUrl: server.baseUrl, upload: "u1", pollMs: 1 });

    assert.deepEqual(await fusion.requestSamples(request), { status: "disconnected" });
    await fusion.reconnected();
    assert.deepEqual(await fusion.requestSamples(request), { status: "answered", response });
    // 끊긴 동안 걸어 둔 요청은 서버에 남아 애드인이 다시 붙으면 가져가므로, 같은 요청을 또 걸지 않는다
    assert.equal(server.posted.length, 1);
  } finally {
    await server.close();
  }
});

test("애드인이 샘플을 뽑지 못했으면 그 이유와 함께 실패를 돌려준다", async () => {
  const server = await fakeServer([{ status: "failed", fusion: "connected", reason: "재계산 실패" }]);
  try {
    const answer = await httpFusion({ baseUrl: server.baseUrl, upload: "u1", pollMs: 1 }).requestSamples(request);

    assert.deepEqual(answer, { status: "failed", reason: "재계산 실패" });
  } finally {
    await server.close();
  }
});

test("서버가 요청을 받지 않으면 서버의 답을 담아 실패한다", async () => {
  const server = await fakeServer([]);
  try {
    const fusion = httpFusion({ baseUrl: server.baseUrl, upload: "없는-업로드", pollMs: 1 });

    await assert.rejects(fusion.requestSamples(request), /404.*없음/);
  } finally {
    await server.close();
  }
});
