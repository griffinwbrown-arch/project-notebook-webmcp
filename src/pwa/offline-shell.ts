export type OfflineShellState =
  | { readonly status: "unsupported" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string };

export async function registerOfflineShell(): Promise<OfflineShellState> {
  if (!("serviceWorker" in navigator)) {
    return { status: "unsupported" };
  }

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return { status: "ready" };
  } catch (error: unknown) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "The offline shell could not be prepared.",
    };
  }
}
