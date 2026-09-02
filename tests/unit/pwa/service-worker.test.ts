import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://notebook.test";
const CURRENT_CACHE = "project-notebook-realignment-shell-v3";
const PREVIOUS_CACHE = "project-notebook-realignment-shell-v2";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ATLAS_RESPONSE_BYTES = 8 * 1024 * 1024;
const ATLAS_BYTE_LENGTH = 7_206_984;
const ATLAS_PATH = "/assets/anatomy/authority-atlas-206.glb";
const ATLAS_URL = `${ORIGIN}${ATLAS_PATH}`;

type RequestLike = Readonly<{
  url: string;
  method: string;
  mode: string;
}>;

type ResponseOptions = Readonly<{
  ok?: boolean;
  type?: "basic" | "default" | "opaque" | "error";
  headers?: Readonly<Record<string, string>>;
  byteLength?: number;
}>;

class FakeHeaders {
  private readonly values: ReadonlyMap<string, string>;

  public constructor(values: Readonly<Record<string, string>> = {}) {
    this.values = new Map(
      Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  public get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}

class FakeResponse {
  public readonly ok: boolean;
  public readonly type: "basic" | "default" | "opaque" | "error";
  public readonly headers: FakeHeaders;
  private readonly bytes: Uint8Array;
  private readonly textBody: string;

  public constructor(body = "", options: ResponseOptions = {}) {
    this.ok = options.ok ?? true;
    this.type = options.type ?? "basic";
    this.headers = new FakeHeaders(options.headers);
    this.textBody = body;
    this.bytes = options.byteLength === undefined
      ? new TextEncoder().encode(body)
      : new Uint8Array(options.byteLength);
  }

  public clone(): FakeResponse {
    const headers: Record<string, string> = {};
    const declaredLength = this.headers.get("content-length");
    if (declaredLength !== null) headers["content-length"] = declaredLength;
    return new FakeResponse(this.textBody, {
      ok: this.ok,
      type: this.type,
      headers,
      byteLength: this.bytes.byteLength,
    });
  }

  public async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer;
  }

  public async text(): Promise<string> {
    return this.textBody;
  }

  public static error(): FakeResponse {
    return new FakeResponse("", { ok: false, type: "error" });
  }
}

function requestKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") {
    return value.url;
  }
  throw new Error("The worker received an unsupported cache request.");
}

class FakeCache {
  private readonly entries = new Map<string, FakeResponse>();

  public async put(request: unknown, response: FakeResponse): Promise<void> {
    this.entries.set(requestKey(request), response.clone());
  }

  public async match(request: unknown): Promise<FakeResponse | undefined> {
    return this.entries.get(requestKey(request))?.clone();
  }

  public async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }

  public async delete(request: unknown): Promise<boolean> {
    return this.entries.delete(requestKey(request));
  }
}

class FakeCacheStorage {
  private readonly stores = new Map<string, FakeCache>();

  public async open(name: string): Promise<FakeCache> {
    const cache = this.stores.get(name) ?? new FakeCache();
    this.stores.set(name, cache);
    return cache;
  }

  public async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  public async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  public async match(request: unknown): Promise<FakeResponse | undefined> {
    for (const cache of this.stores.values()) {
      const response = await cache.match(request);
      if (response !== undefined) return response;
    }
    return undefined;
  }
}

class FakeNetwork {
  private readonly routes = new Map<string, FakeResponse | Error>();
  public readonly calls: { readonly input: unknown; readonly init: unknown }[] = [];

  public route(key: string, response: FakeResponse | Error): void {
    this.routes.set(key, response);
  }

  public async fetch(input: unknown, init: unknown = undefined): Promise<FakeResponse> {
    this.calls.push({ input, init });
    const response = this.routes.get(requestKey(input));
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`No route for ${requestKey(input)}.`);
    return response.clone();
  }
}

type WorkerEvent = {
  readonly pending: Promise<unknown>[];
  response: Promise<unknown> | undefined;
  request?: RequestLike;
  waitUntil(value: Promise<unknown>): void;
  respondWith(value: Promise<unknown>): void;
};

function createEvent(): WorkerEvent {
  const event: WorkerEvent = {
    pending: [],
    response: undefined,
    waitUntil(value) {
      event.pending.push(value);
    },
    respondWith(value) {
      event.response = value;
    },
  };
  return event;
}

type WorkerHarness = Readonly<{
  caches: FakeCacheStorage;
  network: FakeNetwork;
  skipWaitingCalls: () => number;
  claimCalls: () => number;
  dispatch(name: "install" | "activate" | "fetch", event?: WorkerEvent): Promise<WorkerEvent>;
}>;

async function createWorkerHarness(): Promise<WorkerHarness> {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const caches = new FakeCacheStorage();
  const network = new FakeNetwork();
  let skipWaitingCount = 0;
  let claimCount = 0;
  const serviceWorker = {
    location: { origin: ORIGIN },
    clients: {
      claim: async (): Promise<void> => {
        claimCount += 1;
      },
    },
    skipWaiting: (): void => {
      skipWaitingCount += 1;
    },
    addEventListener: (name: string, listener: (event: WorkerEvent) => void): void => {
      listeners.set(name, listener);
    },
  };
  vi.resetModules();
  vi.stubGlobal("URL", URL);
  vi.stubGlobal("Response", FakeResponse);
  vi.stubGlobal("caches", caches);
  vi.stubGlobal("fetch", (input: unknown, init: unknown = undefined): Promise<FakeResponse> => network.fetch(input, init));
  vi.stubGlobal("self", serviceWorker);
  // @ts-expect-error The public worker is a classic JavaScript entry without a TypeScript module declaration.
  await import("../../../public/sw.js");

  return {
    caches,
    network,
    skipWaitingCalls: () => skipWaitingCount,
    claimCalls: () => claimCount,
    dispatch: async (name, event = createEvent()): Promise<WorkerEvent> => {
      const listener = listeners.get(name);
      if (listener === undefined) throw new Error(`No ${name} listener was installed.`);
      listener(event);
      await Promise.all(event.pending);
      return event;
    },
  };
}

function request(url: string, options: Readonly<Partial<Omit<RequestLike, "url">>> = {}): RequestLike {
  return {
    url,
    method: options.method ?? "GET",
    mode: options.mode ?? "same-origin",
  };
}

async function responseText(response: Promise<unknown> | undefined): Promise<string> {
  const value = await response;
  if (!(value instanceof FakeResponse)) throw new Error("The worker did not return a response.");
  return value.text();
}

describe("service worker cache boundaries", () => {
  it("installs the desk shell and deduplicated static assets, then activates the new cache", async () => {
    const worker = await createWorkerHarness();
    worker.network.route(
      "/desk",
      new FakeResponse(
        '<link href="/_next/static/app.css"><script src="/_next/static/app.js"></script><script src="/_next/static/app.js"></script><script src="/_next/static/app.js?build=1">',
      ),
    );
    worker.network.route("/manifest.webmanifest", new FakeResponse("manifest"));
    worker.network.route("/covers/composition-marble-template.png", new FakeResponse("cover"));
    worker.network.route("/_next/static/app.css", new FakeResponse("css"));
    worker.network.route("/_next/static/app.js", new FakeResponse("js"));
    worker.network.route("/_next/static/app.js?build=1", new FakeResponse("js-1"));

    await worker.dispatch("install");

    expect(worker.skipWaitingCalls()).toBe(1);
    const cache = await worker.caches.open(CURRENT_CACHE);
    expect(await cache.keys()).toEqual([
      "/desk",
      "/manifest.webmanifest",
      "/covers/composition-marble-template.png",
      "/_next/static/app.css",
      "/_next/static/app.js",
      "/_next/static/app.js?build=1",
    ]);
    expect(worker.network.calls.map(({ init }) => init)).toEqual([
      { cache: "reload" },
      { cache: "reload" },
      { cache: "reload" },
      { cache: "reload" },
      { cache: "reload" },
      { cache: "reload" },
    ]);

    const oldCache = await worker.caches.open("project-notebook-old-v1");
    await oldCache.put("/old", new FakeResponse("old"));
    await (await worker.caches.open(PREVIOUS_CACHE)).put("/previous", new FakeResponse("previous"));
    await (await worker.caches.open("unrelated-cache")).put("/keep", new FakeResponse("keep"));
    await worker.dispatch("activate");

    expect(worker.claimCalls()).toBe(1);
    expect(await worker.caches.keys()).toEqual([CURRENT_CACHE, "unrelated-cache"]);
  });

  it("serves the cached authority atlas on warm load without a second network request", async () => {
    const worker = await createWorkerHarness();
    worker.network.route(ATLAS_URL, new FakeResponse("", {
      headers: { "content-length": String(ATLAS_BYTE_LENGTH) },
      byteLength: ATLAS_BYTE_LENGTH,
    }));

    const onlineEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(onlineEvent, { request: request(ATLAS_URL) }),
    );
    await expect(onlineEvent.response).resolves.toMatchObject({ ok: true });

    const cache = await worker.caches.open(CURRENT_CACHE);
    const cachedAtlas = await cache.match(ATLAS_URL);
    expect(cachedAtlas).toBeDefined();
    if (cachedAtlas === undefined) {
      throw new Error("The authority atlas was not cached.");
    }
    expect((await cachedAtlas.arrayBuffer()).byteLength).toBe(ATLAS_BYTE_LENGTH);

    worker.network.route(ATLAS_URL, new Error("offline"));
    const warmEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(warmEvent, { request: request(ATLAS_URL) }),
    );
    const warmAtlas = await warmEvent.response;
    expect(warmAtlas).toBeInstanceOf(FakeResponse);
    if (!(warmAtlas instanceof FakeResponse)) {
      throw new Error("The cached authority atlas was not returned.");
    }
    expect((await warmAtlas.arrayBuffer()).byteLength).toBe(ATLAS_BYTE_LENGTH);
    expect(worker.network.calls.map(({ input }) => requestKey(input))).toEqual([ATLAS_URL]);
  });

  it("rejects an authority atlas response over 8 MiB", async () => {
    const worker = await createWorkerHarness();
    const oversizedAtlasBytes = MAX_ATLAS_RESPONSE_BYTES + 1;
    worker.network.route(ATLAS_URL, new FakeResponse("", {
      headers: { "content-length": String(oversizedAtlasBytes) },
      byteLength: oversizedAtlasBytes,
    }));

    const onlineEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(onlineEvent, { request: request(ATLAS_URL) }),
    );
    await expect(onlineEvent.response).resolves.toMatchObject({ ok: true });
    expect(await (await worker.caches.open(CURRENT_CACHE)).match(ATLAS_URL)).toBeUndefined();

    worker.network.route(ATLAS_URL, new Error("offline"));
    const offlineEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(offlineEvent, { request: request(ATLAS_URL) }),
    );
    await expect(offlineEvent.response).resolves.toMatchObject({ ok: false, type: "error" });
  });

  it("keeps the 5 MiB limit elsewhere and ignores atlas URL variants", async () => {
    const worker = await createWorkerHarness();
    const unrelatedUrl = `${ORIGIN}/_next/static/atlas-sized.js`;
    worker.network.route(unrelatedUrl, new FakeResponse("", {
      headers: { "content-length": String(ATLAS_BYTE_LENGTH) },
      byteLength: ATLAS_BYTE_LENGTH,
    }));

    const event = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(event, { request: request(unrelatedUrl) }),
    );
    await expect(event.response).resolves.toMatchObject({ ok: true });
    expect(ATLAS_BYTE_LENGTH).toBeGreaterThan(MAX_RESPONSE_BYTES);
    expect(await (await worker.caches.open(CURRENT_CACHE)).match(unrelatedUrl)).toBeUndefined();

    const atlasQueryUrl = `${ATLAS_URL}?variant=1`;
    const queryEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(queryEvent, { request: request(atlasQueryUrl) }),
    );
    expect(queryEvent.response).toBeUndefined();
    expect(await (await worker.caches.open(CURRENT_CACHE)).match(atlasQueryUrl)).toBeUndefined();
  });

  it("keeps unrelated cached resources network-first", async () => {
    const worker = await createWorkerHarness();
    const assetUrl = `${ORIGIN}/_next/static/network-first.js`;
    const cache = await worker.caches.open(CURRENT_CACHE);
    await cache.put(assetUrl, new FakeResponse("stale"));
    worker.network.route(assetUrl, new FakeResponse("fresh"));

    const event = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(event, { request: request(assetUrl) }),
    );

    await expect(responseText(event.response)).resolves.toBe("fresh");
    await expect(responseText(cache.match(assetUrl))).resolves.toBe("fresh");
    expect(worker.network.calls.map(({ input }) => requestKey(input))).toEqual([assetUrl]);
  });

  it("fails installation at the shell or asset boundary and does not cache an oversized response", async () => {
    const worker = await createWorkerHarness();
    worker.network.route("/desk", new FakeResponse("shell", { ok: false }));
    await expect(worker.dispatch("install")).rejects.toThrow("notebook shell could not be cached");

    worker.network.route("/desk", new FakeResponse("shell"));
    worker.network.route(
      "/manifest.webmanifest",
      new FakeResponse("small", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    );
    worker.network.route("/covers/composition-marble-template.png", new FakeResponse("cover"));
    await expect(worker.dispatch("install")).rejects.toThrow("manifest.webmanifest exceeds the cache policy");

    const cache = await worker.caches.open(CURRENT_CACHE);
    expect(await cache.keys()).toEqual(["/desk"]);

    const shellLimitWorker = await createWorkerHarness();
    shellLimitWorker.network.route(
      "/desk",
      new FakeResponse("shell", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    );
    await expect(shellLimitWorker.dispatch("install")).rejects.toThrow("notebook shell exceeds the offline cache policy");
  });

  it("handles only same-origin notebook GETs and bounds the cache to the newest 80 entries", async () => {
    const worker = await createWorkerHarness();
    const ignoredRequests = [
      request(`${ORIGIN}/desk`, { method: "POST", mode: "navigate" }),
      request(`${ORIGIN}/desk`, { mode: "navigate", method: "HEAD" }),
      request("https://other.test/desk", { mode: "navigate" }),
      request(`${ORIGIN}/other`, { mode: "navigate" }),
      request(`${ORIGIN}/api/notebook`),
    ];
    for (const ignored of ignoredRequests) {
      const event = createEvent();
      await worker.dispatch("fetch", Object.assign(event, { request: ignored }));
      expect(event.response).toBeUndefined();
    }

    const cache = await worker.caches.open(CURRENT_CACHE);
    for (let index = 0; index < 80; index += 1) {
      await cache.put(`${ORIGIN}/_next/static/old-${index}.js`, new FakeResponse(String(index)));
    }
    worker.network.route(`${ORIGIN}/_next/static/new.js`, new FakeResponse("new"));
    const networkEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(networkEvent, { request: request(`${ORIGIN}/_next/static/new.js`) }),
    );
    expect(await networkEvent.response).toMatchObject({ ok: true });
    const boundedKeys = await cache.keys();
    expect(boundedKeys).toHaveLength(80);
    expect(boundedKeys).not.toContain(`${ORIGIN}/_next/static/old-0.js`);
    expect(boundedKeys).toContain(`${ORIGIN}/_next/static/old-1.js`);
    expect(boundedKeys).toContain(`${ORIGIN}/_next/static/new.js`);

    worker.network.route(`${ORIGIN}/`, new FakeResponse("root"));
    const rootEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(rootEvent, { request: request(`${ORIGIN}/`, { mode: "navigate" }) }),
    );
    await expect(responseText(rootEvent.response)).resolves.toBe("root");

    worker.network.route(`${ORIGIN}/_next/static/default.js`, new FakeResponse("default", { type: "default" }));
    const defaultEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(defaultEvent, { request: request(`${ORIGIN}/_next/static/default.js`) }),
    );
    expect(defaultEvent.response).toBeDefined();
    await expect(defaultEvent.response).resolves.toMatchObject({ ok: true, type: "default" });
    expect(await cache.match(`${ORIGIN}/_next/static/default.js`)).toBeDefined();

    worker.network.route(`${ORIGIN}/_next/static/not-ok.js`, new FakeResponse("not ok", { ok: false, type: "basic" }));
    const notOkEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(notOkEvent, { request: request(`${ORIGIN}/_next/static/not-ok.js`) }),
    );
    expect(await cache.match(`${ORIGIN}/_next/static/not-ok.js`)).toBeUndefined();

    worker.network.route(`${ORIGIN}/_next/static/exact-limit.js`, new FakeResponse("exact", {
      headers: { "content-length": String(MAX_RESPONSE_BYTES) },
    }));
    const exactLimitEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(exactLimitEvent, { request: request(`${ORIGIN}/_next/static/exact-limit.js`) }),
    );
    await expect(exactLimitEvent.response).resolves.toMatchObject({ ok: true });
    expect(await cache.keys()).toContain(`${ORIGIN}/_next/static/exact-limit.js`);
    expect(await cache.match(`${ORIGIN}/_next/static/exact-limit.js`)).toBeDefined();

    worker.network.route(`${ORIGIN}/_next/static/body-too-large.js`, new FakeResponse("", {
      headers: { "content-length": "1" },
      byteLength: MAX_RESPONSE_BYTES + 1,
    }));
    const bodyLimitEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(bodyLimitEvent, { request: request(`${ORIGIN}/_next/static/body-too-large.js`) }),
    );
    expect(await cache.match(`${ORIGIN}/_next/static/body-too-large.js`)).toBeUndefined();

    worker.network.route(`${ORIGIN}/_next/static/opaque.js`, new FakeResponse("opaque", { type: "opaque" }));
    const opaqueEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(opaqueEvent, { request: request(`${ORIGIN}/_next/static/opaque.js`) }),
    );
    expect(await cache.match(`${ORIGIN}/_next/static/opaque.js`)).toBeUndefined();
  });

  it("returns an exact cached response, then the desk shell, and finally a network error", async () => {
    const worker = await createWorkerHarness();
    const cache = await worker.caches.open(CURRENT_CACHE);
    await cache.put(`${ORIGIN}/_next/static/cached.js`, new FakeResponse("cached"));
    await cache.put("/desk", new FakeResponse("shell fallback"));

    worker.network.route(`${ORIGIN}/_next/static/cached.js`, new Error("offline"));
    const cachedEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(cachedEvent, { request: request(`${ORIGIN}/_next/static/cached.js`) }),
    );
    await expect(cachedEvent.response).resolves.toMatchObject({ ok: true });
    await expect(responseText(cachedEvent.response)).resolves.toBe("cached");

    worker.network.route(`${ORIGIN}/desk?new=1`, new Error("offline"));
    const navigationEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(navigationEvent, { request: request(`${ORIGIN}/desk?new=1`, { mode: "navigate" }) }),
    );
    await expect(responseText(navigationEvent.response)).resolves.toBe("shell fallback");

    worker.network.route(`${ORIGIN}/_next/static/missing.js`, new Error("offline"));
    const missingEvent = createEvent();
    await worker.dispatch(
      "fetch",
      Object.assign(missingEvent, { request: request(`${ORIGIN}/_next/static/missing.js`) }),
    );
    await expect(missingEvent.response).resolves.toMatchObject({ ok: false, type: "error" });

    const noShellWorker = await createWorkerHarness();
    noShellWorker.network.route(`${ORIGIN}/desk?no-shell=1`, new Error("offline"));
    const noShellEvent = createEvent();
    await noShellWorker.dispatch(
      "fetch",
      Object.assign(noShellEvent, { request: request(`${ORIGIN}/desk?no-shell=1`, { mode: "navigate" }) }),
    );
    await expect(noShellEvent.response).resolves.toMatchObject({ ok: false, type: "error" });
  });
});
