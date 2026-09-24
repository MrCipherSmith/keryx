// Public surface of `src/stack/` (flow 309, W1, Lane A) — detection +
// persistence. Other lanes (B: install manifest, C: governance) import stack
// detection through this file rather than reaching into `detect.ts`/
// `service.ts` directly.

export {
  STACK_DETECTION_SCHEMA_VERSION,
  STACK_DETECT_TAGS,
  defaultStackDetectFs,
  detectStack,
  type DetectStackOptions,
  type StackDetection,
  type StackDetectionCore,
  type StackDetectFs,
  type StackDirEntry,
  type StackFamily,
  type StackPerSignal,
} from "./detect";

export {
  readStackDetection,
  runStackDetect,
  serializeStackDetection,
  stackJsonPath,
  type RunStackDetectOptions,
} from "./service";
