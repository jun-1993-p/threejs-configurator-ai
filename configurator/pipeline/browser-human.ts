// 브라우저 사람 결정 포트: 운영자 화면을 작은 HTTP 서버로 띄우고, 운영자가 브라우저에서 보낸 양식을 사람 결정으로 읽는다.
// 결정을 기다리는 화면은 한 번에 하나다. 기다리지 않는 동안은 진행 중 화면이 몇 초마다 다시 읽혀 다음 화면을 보인다.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { candidateCardsHtml, finalApprovalHtml, progressHtml, readCandidateChoice, readFinalApproval } from "./operator-screens.ts";
import type { HumanPort } from "./runner.ts";

/** 결정을 기다리는 화면: 보일 HTML과, 보낸 양식을 읽어 결정을 끝내거나(true) 막힌 까닭을 화면에 다시 보이는(false) 함수 */
interface Screen {
  html: string;
  submit(form: URLSearchParams): boolean;
}

export interface BrowserHuman extends HumanPort {
  /** 운영자가 여는 주소 */
  url: string;
  close(): Promise<void>;
}

/**
 * assets: 화면이 경로로 가리키는 파일(AI 판정이 문제를 찾은 렌더링 PNG). 없으면 undefined.
 * host·port: 기본은 이 머신에서만 열리는 127.0.0.1과 빈 포트다.
 */
export async function browserHuman({
  product,
  assets,
  host = "127.0.0.1",
  port = 0,
}: {
  product: string;
  assets: (path: string) => Buffer | undefined;
  host?: string;
  port?: number;
}): Promise<BrowserHuman> {
  let screen: Screen | undefined;

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (path !== "/") {
      const file = req.method === "GET" ? assets(path.slice(1)) : undefined;
      if (file) res.writeHead(200, { "content-type": "image/png" }).end(file);
      else res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") return html(screen?.html ?? progressHtml(product));
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const current = screen;
      if (current?.submit(new URLSearchParams(raw))) screen = undefined;
      html(screen?.html ?? progressHtml(product));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  /** 화면을 띄우고 받아들일 수 있는 양식이 올 때까지 기다린다. read가 errors를 돌려주면 그 까닭을 넣은 화면(render)을 다시 보인다. */
  const ask = <T>(render: (errors: string[]) => string, read: (form: URLSearchParams) => T | { errors: string[] }) =>
    new Promise<T>((resolve) => {
      const shown: Screen = {
        html: render([]),
        submit(form) {
          const answer = read(form);
          if (typeof answer === "object" && answer !== null && "errors" in answer) {
            shown.html = render(answer.errors);
            return false;
          }
          resolve(answer);
          return true;
        },
      };
      screen = shown;
    });

  return {
    url: `http://${host}:${address.port}/`,
    chooseCandidate: (cards) => ask((errors) => candidateCardsHtml(product, cards, errors), (form) => readCandidateChoice(form, cards)),
    // 실행기가 막은 앞 결정의 까닭(review.errors)이 있으면 처음부터 보이고, 양식이 막히면 그 까닭으로 바꿔 보인다
    finalApproval: (review) =>
      ask((errors) => finalApprovalHtml({ ...review, errors: errors.length > 0 ? errors : review.errors }), (form) => readFinalApproval(form, review.spec)),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
