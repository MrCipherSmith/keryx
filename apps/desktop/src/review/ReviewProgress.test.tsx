import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewProgress } from "./ReviewProgress";

const caption = (showState?: boolean) =>
  renderToStaticMarkup(createElement(ReviewProgress, { state: "partial", ...(showState !== undefined && { showState }) }));

test("TP-R3-005: ReviewProgress names a labelled run state only when asked to show it", () => {
  expect(caption()).not.toContain("Partial");
  expect(caption(false)).not.toContain("Partial");
  expect(caption(true)).toContain("Partial · ");
});
