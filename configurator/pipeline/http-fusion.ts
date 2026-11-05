// HTTP Fusion 연결 포트(ADR-0013): 서버(server/app.py)의 추가 샘플 요청 API로 업로드한 애드인에 샘플을 받는다.
// 서버는 요청을 걸어 두고, 애드인이 몇 초마다 가져가 답한다. 애드인 소식이 끊기면 서버가 요청 상태에 disconnected를 싣는다.
import type { FusionPort, SampleAnswer } from "./runner.ts";
import type { SampleRequest } from "./verify-spec.ts";

/** 서버가 돌려주는 추가 샘플 요청 상태(GET /uploads/{업로드}/sample-requests/{요청}) */
export type RequestStatus ={ status: "pending" | "answered" | "failed"; fusion: "connected" | "disconnected"; response?: unknown; reason?: string };

/** pollMs: 요청 상태를 보는 간격 */
export function httpFusion({ baseUrl, upload, pollMs = 1000 }: { baseUrl: string; upload: string; pollMs?: number }): FusionPort {
  const requests = `${baseUrl}/uploads/${encodeURIComponent(upload)}/sample-requests`;
  /** 걸어 둔 요청 id. 끊긴 뒤 다시 물어도 같은 요청을 기다린다(서버에 남아 애드인이 다시 붙으면 가져간다). */
  const opened = new Map<string, string>();
  /** 끊김을 알린 요청. reconnected가 이 요청 상태로 연결을 본다. */
  let waiting: string | undefined;

  async function call<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`서버가 추가 샘플 요청에 ${res.status}로 답했습니다: ${await res.text()}`);
    return (await res.json()) as T;
  }
  const status = (id: string) => call<RequestStatus>(`${requests}/${id}`);
  const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));

  return {
    async requestSamples(request: SampleRequest): Promise<SampleAnswer> {
      const key = JSON.stringify(request);
      let id = opened.get(key);
      if (!id) {
        ({ id } = await call<{ id: string }>(requests, { method: "POST", headers: { "content-type": "application/json" }, body: key }));
        opened.set(key, id);
      }
      for (;;) {
        const now = await status(id);
        if (now.status === "answered") return { status: "answered", response: now.response };
        if (now.status === "failed") return { status: "failed", reason: now.reason ?? "" };
        if (now.fusion === "disconnected") {
          waiting = id;
          return { status: "disconnected" };
        }
        await pause();
      }
    },
    async reconnected(): Promise<void> {
      if (!waiting) return;
      while ((await status(waiting)).fusion === "disconnected") await pause();
      waiting = undefined;
    },
  };
}
