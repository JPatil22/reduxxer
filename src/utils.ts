/**
 * A lightweight concurrency limiter that mimics p-limit.
 * Takes a max concurrency count and returns a function that wraps async functions.
 */
export function pLimit(concurrency: number) {
  const queue: (() => void)[] = [];
  let active = 0;

  const next = () => {
    active--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
