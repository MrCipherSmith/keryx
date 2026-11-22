import { MetaprojectRequestError, metaprojectExplorer, parseExplorerRequest } from "../integrations/service";

export async function metaprojectExplorerCommand(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--request" || !args[1] || args[1].length > 32_768) throw new Error("Usage: keryx metaproject-explorer --request '<json>'");
  let output: string;
  try {
    const request = parseExplorerRequest(JSON.parse(args[1]) as unknown);
    output = `${JSON.stringify(await metaprojectExplorer(process.cwd(), request))}\n`;
  } catch (error) {
    if (error instanceof MetaprojectRequestError) throw new Error(`${error.code}: ${error.message}`, { cause: error });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
}
