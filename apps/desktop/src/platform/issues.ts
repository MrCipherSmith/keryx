import { invoke } from "./backend";
import { errMessage } from "../lib/format";
import { isIssueViewer } from "../../../../src/integrations/issues-contract";

export type IssuesAction = "origin" | "viewer" | "list" | "detail" | "comments" | "project" | "move" | "workspace" | "open-session" | "prepare-flow";

export async function requestIssues<T>(cwd: string, login: string, action: IssuesAction, request: object): Promise<T> {
  let response: unknown;
  try {
    response = await invoke("issues_request", { cwd, login, action, request });
  } catch (error) {
    if (/unknown (command|subcommand).*issues|did not return a valid Review response/i.test(errMessage(error))) {
      throw new Error("This CLI does not support Issues. Choose the bundled CLI in Desktop Settings.");
    }
    throw error;
  }
  if (!response || typeof response !== "object" || !("viewer" in response) || !isIssueViewer(response.viewer)) {
    throw new Error("Incompatible Issues response. Choose the bundled CLI in Desktop Settings.");
  }
  if (response.viewer.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error("account_mismatch: GitHub account changed. Select the account again.");
  }
  return response as T;
}
