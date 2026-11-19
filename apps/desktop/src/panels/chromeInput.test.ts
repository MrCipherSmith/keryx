import { expect, test } from "bun:test";
import { isAppShortcut, keyInput, keyText, modifiers, mouseInput, pagePoint, wheelInput } from "./chromeInput";

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

test("modifiers use CDP's bit mask", () => {
  expect(modifiers(none)).toBe(0);
  expect(modifiers({ ...none, altKey: true, shiftKey: true })).toBe(9);
  expect(modifiers({ ...none, ctrlKey: true, metaKey: true })).toBe(6);
});

test("canvas points scale to the page's CSS pixels", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };
  expect(pagePoint({ clientX: 300, clientY: 200 }, rect, 400, 300)).toEqual({ x: 200, y: 150 });
  // A frame from a moment when the page was twice as wide.
  expect(pagePoint({ clientX: 300, clientY: 200 }, rect, 800, 600)).toEqual({ x: 400, y: 300 });
});

test("mouse buttons, double clicks and moves", () => {
  expect(mouseInput("mousePressed", { ...none, button: 0, detail: 1 }, { x: 1, y: 2 })).toEqual({
    kind: "mouse", type: "mousePressed", x: 1, y: 2, button: "left", clicks: 1, modifiers: 0,
  });
  expect(mouseInput("mousePressed", { ...none, button: 2, detail: 2 }, { x: 1, y: 2 })).toMatchObject({ button: "right", clicks: 2 });
  expect(mouseInput("mouseMoved", { ...none, button: 0, detail: 0 }, { x: 1, y: 2 })).toMatchObject({ button: "none", clicks: 0 });
  // A move with the left button held is a drag: it carries the button and the held mask.
  expect(mouseInput("mouseMoved", { ...none, button: 0, detail: 0 }, { x: 1, y: 2 }, 0)).toMatchObject({ button: "left", buttons: 1 });
  expect(mouseInput("mouseMoved", { ...none, button: 0, detail: 0 }, { x: 1, y: 2 }, 2)).toMatchObject({ button: "right", buttons: 2 });
});

test("wheel lines become pixels", () => {
  expect(wheelInput({ ...none, deltaX: 0, deltaY: 3, deltaMode: 1 }, { x: 0, y: 0 })).toMatchObject({ kind: "wheel", dy: 120 });
  expect(wheelInput({ ...none, deltaX: 5, deltaY: 10, deltaMode: 0 }, { x: 0, y: 0 })).toMatchObject({ dx: 5, dy: 10 });
});

test("keys type text only when printable and not a chord", () => {
  expect(keyText({ key: "a", metaKey: false, ctrlKey: false })).toBe("a");
  expect(keyText({ key: "Enter", metaKey: false, ctrlKey: false })).toBe("\r");
  expect(keyText({ key: "ArrowLeft", metaKey: false, ctrlKey: false })).toBeUndefined();
  expect(keyText({ key: "a", metaKey: true, ctrlKey: false })).toBeUndefined();
  expect(keyInput("keyDown", { ...none, key: "b", code: "KeyB", keyCode: 66 })).toEqual({
    kind: "key", type: "keyDown", key: "b", code: "KeyB", text: "b", keyCode: 66, modifiers: 0,
  });
  expect("text" in keyInput("keyUp", { ...none, key: "b", code: "KeyB", keyCode: 66 })).toBe(false);
});

test("the app keeps its own shortcuts; editing chords go to the page", () => {
  expect(isAppShortcut({ ...none, code: "KeyB", metaKey: true, shiftKey: true })).toBe(true);
  expect(isAppShortcut({ ...none, code: "KeyC", metaKey: true, shiftKey: true })).toBe(true);
  expect(isAppShortcut({ ...none, code: "Backquote", ctrlKey: true })).toBe(true);
  expect(isAppShortcut({ ...none, code: "KeyW", metaKey: true })).toBe(true);
  expect(isAppShortcut({ ...none, code: "KeyA", metaKey: true })).toBe(false);
  expect(isAppShortcut({ ...none, code: "KeyZ", metaKey: true })).toBe(false);
  expect(isAppShortcut({ ...none, code: "KeyA" })).toBe(false);
});
