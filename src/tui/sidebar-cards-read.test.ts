// Flow 468 phase C: how the cards read the former sections. Pure fakes, no renderer.
import { expect, test } from "bun:test";
import { collectRenderableText } from "./sidebar-cards";

type Fake = { id?: string; visible?: boolean; plainText?: string; getChildren?: () => Fake[] };

function text(id: string, plainText: string, visible = true): Fake {
  return { id, plainText, visible };
}

function box(id: string, children: Fake[]): Fake {
  return { id, getChildren: () => children };
}

test("flow 468 AC12: a former section's text is read from its nodes, label rows and hidden rows left out", () => {
  const section = box("sb-governance", [
    text("sb-governance-k", "Governance"),
    text("sb-governance-v", "last report 2026-10-20 19:00"),
    text("sb-governance-hidden", "never shown", false),
    box("sb-governance-more", [text("sb-governance-row", "  3 flows open  \n\n  1 held")]),
  ]);
  expect(collectRenderableText(section)).toBe("last report 2026-10-20 19:00\n  3 flows open\n  1 held");
});

test("flow 468 AC12: a missing or empty section reads as an empty string", () => {
  expect(collectRenderableText(undefined)).toBe("");
  expect(collectRenderableText(null)).toBe("");
  expect(collectRenderableText(box("sb-empty", []))).toBe("");
  expect(collectRenderableText(box("sb-blank", [text("sb-blank-v", "   \n")]))).toBe("");
});
