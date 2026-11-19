// One lane per navigation surface and webview. A slow read may finish in the
// background; keep one slot for the next selection and only its latest successor.
export class ReviewReadLane<T> {
  private active = new Map<string, Promise<T>>();
  private waiting?: { key: string; promise: Promise<T>; start: () => void; reject: (error: Error) => void };

  read(key: string, load: () => Promise<T>): Promise<T> {
    if (this.waiting?.key === key) return this.waiting.promise;
    if (this.waiting) {
      this.waiting.reject(new Error("unavailable: A newer Review request superseded this read."));
      delete this.waiting;
    }
    const current = this.active.get(key);
    if (current) return current;
    const start = () => {
      const promise = Promise.resolve().then(load).finally(() => {
        this.active.delete(key);
        const next = this.waiting;
        delete this.waiting;
        next?.start();
      });
      this.active.set(key, promise);
      return promise;
    };
    if (this.active.size < 2) return start();
    let resolve!: (result: Promise<T>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    this.waiting = { key, promise, reject, start: () => resolve(start()) };
    return promise;
  }
}
