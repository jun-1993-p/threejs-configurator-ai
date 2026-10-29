// 메모리 저장소 포트. 시험과 개발용이며, 넣은 것을 그대로 들여다볼 수 있다.
import type { ProductFiles } from "./assemble.ts";
import type { CaseRecord, LogEntry, StorePort, Style } from "./runner.ts";

export interface MemoryStore extends StorePort {
  log: LogEntry[];
  submissions: { product: string; files: ProductFiles }[];
  cases: CaseRecord[];
}

export function memoryStore({ styles }: { styles: Style[] }): MemoryStore {
  const store: MemoryStore = {
    log: [],
    submissions: [],
    cases: [],
    styles: () => Promise.resolve(structuredClone(styles)),
    appendLog: async (entry) => void store.log.push(entry),
    submit: async (product, files) => void store.submissions.push({ product, files }),
    recordCase: async (record) => void store.cases.push(structuredClone(record)),
  };
  return store;
}
