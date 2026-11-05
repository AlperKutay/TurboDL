import { DEFAULT_LIST_WAIT, DEFAULT_SAVE_OPTIONS, type ApiInfo, type JobRequest, type ListWait, type ProfileListView, type ProfileSaveOptions, type Result } from "@turbodl/shared";
import type { ParsedListRequest } from "../../src/main/api-routes";
import { UNFINISHED } from "../../src/main/instagram/profile-lists";
import type { JobRecord } from "../../src/main/jobs/job-record";
import { Jobs } from "../../src/main/jobs/jobs";
import type { BotApp } from "../../src/main/telegram/bot";

/** A BotApp over the app's real job registry: a test drives each job through its record (start, progress, file, end). */
export interface FakeApp {
  app: BotApp;
  records: Map<string, JobRecord>;
  created: JobRequest[];
  cancelled: string[];
  started: ParsedListRequest[];
  listCalls: string[];
  list: ProfileListView | null;
  instagram: ApiInfo["instagram"];
  save: ProfileSaveOptions;
  wait: ListWait;
  continueResult: Result;
  closeResult: Result;
  /** startList refuses with this, when set */
  startRefusal: string | null;
  /** jobs end before createJob returns, as one that has nothing to do */
  endAtOnce: boolean;
}

export function makeApp(): FakeApp {
  let ids = 0;
  let jobClock = 0;
  const h = {
    records: new Map<string, JobRecord>(),
    created: [],
    cancelled: [],
    started: [],
    listCalls: [],
    list: null,
    instagram: { signedIn: false },
    save: { ...DEFAULT_SAVE_OPTIONS },
    wait: { ...DEFAULT_LIST_WAIT },
    continueResult: { ok: true },
    closeResult: { ok: true },
    startRefusal: null,
    endAtOnce: false,
  } as unknown as FakeApp;
  const jobs = new Jobs({
    newId: () => `job${++ids}`,
    // a second a read: every progress report goes out
    now: () => (jobClock += 1000),
    run: async (record) => {
      h.records.set(record.id, record);
      // a cancel ends the job, as the app's runners do
      record.signal.addEventListener("abort", () => record.end({ state: "cancelled", reason: "stopped" }));
      if (h.endAtOnce) {
        record.file("C:/dl/at-once.zip");
        record.end({ state: "done" });
      }
      await record.ended;
    },
  });
  h.app = {
    info: async () => ({ app: "TurboDL", version: "0.10.0", api: 1, instagram: h.instagram, features: [] }),
    createJob: (request) => {
      h.created.push(request);
      return jobs.create(request);
    },
    job: (id) => jobs.get(id),
    cancelJob: (id) => {
      h.cancelled.push(id);
      return jobs.cancel(id);
    },
    subscribe: (id, listener) => jobs.subscribe(id, listener),
    list: () => h.list,
    startList: async (request) => {
      h.started.push(request);
      if (h.startRefusal) return { ok: false, error: h.startRefusal };
      if (h.list && h.list.state !== "finished") return { ok: false, error: UNFINISHED };
      h.list = listView("running", request.usernames, request.name);
      return { ok: true };
    },
    stopList: async () => {
      h.listCalls.push("stop");
      if (h.list) h.list = { ...h.list, state: "stopped" };
    },
    continueList: async () => {
      h.listCalls.push("continue");
      return h.continueResult;
    },
    closeList: async () => {
      h.listCalls.push("close");
      return h.closeResult;
    },
    defaults: () => ({ save: h.save, wait: h.wait }),
  };
  return h;
}

export function listView(state: ProfileListView["state"], usernames = ["nasa", "vercel"], name = "old"): ProfileListView {
  return { name, rows: usernames.map((username) => ({ username, state: "waiting" })), index: 0, state, options: { ...DEFAULT_SAVE_OPTIONS }, wait: { ...DEFAULT_LIST_WAIT } };
}
