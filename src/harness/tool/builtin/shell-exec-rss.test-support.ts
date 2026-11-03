// Run only as the subprocess of shell-exec-timeout.test.ts: isolate the RSS
// sampler from the parent test worker while exercising the real output cap.
import { tmpdir } from "node:os";
import { makeCommandRunner } from "./shell-exec-tool";

const baseline = process.memoryUsage().rss;
let peak = baseline;
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
try {
  const result = await makeCommandRunner(tmpdir())("head -c 200000000 /dev/zero | tr '\\0' a");
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({
    peakDelta: peak - baseline,
    isError: result.isError,
    spillLength: result.spill?.full.length ?? 0,
    output: result.output,
  }));
} finally {
  clearInterval(sampler);
}
