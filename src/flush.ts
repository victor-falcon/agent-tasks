// Output to a pipe is written asynchronously: a `process.exit` right after a
// large write cuts what the reader hasn't taken yet (a `top --json` past
// 64 KiB, read by a slower program, arrived as broken JSON). The entry point
// watches stdout and stderr from the start and, before exiting, waits for any
// write that filled the pipe to drain.

type Stream = NodeJS.WriteStream;

/** Notes when a write on `stream` fills its buffer; `drained()` waits until it empties. */
export function watchBackpressure(stream: Stream): { drained(): Promise<void> } {
  let full = false;
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((...args: unknown[]) => {
    const ok = write(...args);
    if (!ok) full = true;
    return ok;
  }) as Stream["write"];
  stream.on("drain", () => {
    full = false;
  });
  return {
    drained() {
      if (!full) return Promise.resolve();
      return new Promise<void>((resolve) => {
        // A reader that goes away (`| head`) ends the wait too: there's no one left to write to.
        const done = () => {
          stream.off("drain", done);
          stream.off("close", done);
          stream.off("error", done);
          resolve();
        };
        stream.once("drain", done);
        stream.once("close", done);
        stream.once("error", done);
      });
    },
  };
}

/** Waits for stdout and stderr to drain, then exits with `code`. */
export async function exitWhenFlushed(code: number, streams: { drained(): Promise<void> }[]): Promise<never> {
  await Promise.all(streams.map((s) => s.drained()));
  process.exit(code);
}
