// Previews and thumbnails share one admission queue: the host takes only a few image reads at once, so more than
// LIMIT concurrent requests would be refused as busy. Eager jobs (a chip being composed) go first.

const LIMIT = 3;
let running = 0;
interface Job { start: () => void; eager: boolean }
const queue: Job[] = [];

/** Run `run` when a slot is free; returns a function that withdraws it while it still waits. */
export function schedulePreview(run: () => Promise<void>, eager: boolean): () => void {
  const start = () => {
    running++;
    const done = () => { running--; queue.shift()?.start(); };
    void run().then(done, done);
  };
  if (running < LIMIT) { start(); return () => {}; }
  const job: Job = { start, eager };
  if (eager) queue.unshift(job);
  else queue.push(job);
  return () => {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  };
}
