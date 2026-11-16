/** Runs `fn` with `handler` on SIGINT (Ctrl+C) instead of the default exit, and removes it afterwards. */
export async function withSigint<T>(handler: () => void, fn: () => Promise<T>): Promise<T> {
  process.on("SIGINT", handler);
  try {
    return await fn();
  } finally {
    process.off("SIGINT", handler);
  }
}
