// B1 acceptance corpus (F-1) — the hand-labeled source for
// `expected/{symbols.jsonl,calls.jsonl}`. Line numbers below are load-bearing:
// the labeled symbol startLines match this layout. Treated as data, not built.

export function alpha() {
  helper();
}
export function helper() {
  return 1;
}
export class Widget {
  render() {
    alpha();
  }
}
export interface Shape {
  area(): number;
}
