// Golden pins for the `editor` profile (Keryx Desktop Client PRD R3: "the
// `editor` profile's roster and answers are unchanged").
//
// Editors (Zed and friends) depend on this surface exactly as it is. Anything
// the shell profile adds must stay behind `--profile shell`; if one of these
// assertions fails, the editor profile changed — update the pins only when
// that change is intended and announced to editor users.

import { describe, expect, test } from "bun:test";
import { buildAcpSessionTools } from "./roster";
import { shellHarness } from "./shell-profile.test-helpers";

/** The roster an editor session offers in a project with no metaproject. */
const EDITOR_TOOL_NAMES = ["get_cwd", "list_dir", "read_file", "search_code", "shell_exec", "apply_patch"];

describe("editor profile golden", () => {
  test("initialize answers exactly the pinned capabilities", async () => {
    const h = shellHarness({ profile: "editor" });
    try {
      const reply = await h.initialize();
      const result = structuredClone(reply.result) as Record<string, unknown>;
      const agentInfo = result["agentInfo"] as Record<string, unknown>;
      expect(agentInfo["name"]).toBe("keryx");
      expect(Object.keys(agentInfo).sort()).toEqual(["name", "version"]);
      delete result["agentInfo"];
      expect(result).toEqual({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {} },
          auth: {},
        },
        authMethods: [],
      });
    } finally {
      await h.end();
    }
  });

  test("session/new answers only sessionId and configOptions: no modes, no shell extensions", async () => {
    const h = shellHarness({ profile: "editor" });
    try {
      await h.initialize();
      const { result } = await h.newSession();
      expect(Object.keys(result).sort()).toEqual(["configOptions", "sessionId"]);
      const options = result["configOptions"] as { id: string; category: string; type: string }[];
      expect(options.map((o) => [o.id, o.category, o.type])).toEqual([["model", "model", "select"]]);
      expect(result["modes"]).toBeUndefined();
      expect(result["_meta"]).toBeUndefined();
    } finally {
      await h.end();
    }
  });

  test("the tool roster is exactly the pinned names", async () => {
    const h = shellHarness({ profile: "editor" });
    try {
      const tools = buildAcpSessionTools({
        root: h.projectDir,
        clientCapabilities: undefined,
        readViaClient: async () => "",
      });
      expect(tools.map((tool) => tool.definition.name)).toEqual(EDITOR_TOOL_NAMES);
    } finally {
      await h.end();
    }
  });
});
