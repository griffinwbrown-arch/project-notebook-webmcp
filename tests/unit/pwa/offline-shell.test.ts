import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOfflineShell } from "../../../src/pwa/offline-shell";

describe("offline shell registration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unsupported when the browser has no service worker", async () => {
    vi.stubGlobal("navigator", {});

    await expect(registerOfflineShell()).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("registers the root-scoped worker and waits for readiness", async () => {
    const ready = Promise.resolve({ state: "activated" });
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    vi.stubGlobal("navigator", { serviceWorker: { register, ready } });

    await expect(registerOfflineShell()).resolves.toEqual({ status: "ready" });
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("returns the registration error message", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockRejectedValue(new Error("registration blocked")),
        ready: Promise.resolve(),
      },
    });

    await expect(registerOfflineShell()).resolves.toEqual({
      status: "error",
      message: "registration blocked",
    });
  });

  it("uses a safe fallback for non-Error failures from readiness", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({ scope: "/" }),
        ready: Promise.reject("worker never became ready"),
      },
    });

    await expect(registerOfflineShell()).resolves.toEqual({
      status: "error",
      message: "The offline shell could not be prepared.",
    });
  });
});
