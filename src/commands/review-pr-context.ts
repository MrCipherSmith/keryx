import { parseArgs } from "node:util";
import { collectPrContext, parseProjectPr, prForFlow } from "../review/pr-context";
import { resolveDeskSubject } from "../review/desk-run-service";

export const PR_CONTEXT_USAGE = "keryx review pr-context (--pr https://github.com/OWNER/REPO/pull/N | --flow ID) [--search TEXT] [--json]";

export async function runPrContext(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) { console.log(PR_CONTEXT_USAGE); return; }
  const { values } = parseArgs({ args, strict: true, options: {
    pr: { type: "string" }, flow: { type: "string" }, search: { type: "string" }, json: { type: "boolean" },
  } });
  if (!!values.pr === !!values.flow || (values.search !== undefined && (!values.search.trim() || values.search.length > 300))) {
    throw new Error(PR_CONTEXT_USAGE);
  }
  const cwd = process.cwd();
  const target = values.flow ? await prForFlow(cwd, values.flow) : parseProjectPr(values.pr);
  if (!target) throw new Error(PR_CONTEXT_USAGE);
  const { key, pr } = await resolveDeskSubject(cwd, target.repo, target.number);
  const snapshot = await collectPrContext(cwd, key, pr, undefined, values.search);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n", error => error ? reject(error) : resolve());
  });
}
