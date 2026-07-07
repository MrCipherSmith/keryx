// Bundled copies of the Metaproject Standard JSON Schemas.
//
// These are faithful copies of
// docs/requirements/metaproject-standard/schemas/*.json, inlined as TypeScript
// objects so the validator never reads from docs/ at runtime (that path is not
// shipped in the published package). Keep these in sync with the source schemas
// when the standard version changes.

export type JsonSchema = {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  minimum?: number;
  minLength?: number;
  pattern?: string;
  format?: string;
  uniqueItems?: boolean;
};

export const MODULE_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://metaproject.dev/schemas/module.schema.json",
  title: "Metaproject Module",
  type: "object",
  additionalProperties: true,
  required: ["enabled", "manifest"],
  properties: {
    enabled: { type: "boolean" },
    version: { type: "string" },
    manifest: { type: "string" },
    core: { type: "string" },
    data: { type: "string" },
    skills: { type: "string" },
    projectSkills: { type: "string" },
    wiki: { type: "string" },
    memory: { type: "string" },
    commands: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    capabilities: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    hooks: {
      type: "object",
      additionalProperties: true,
    },
    schema: { type: "string" },
  },
  anyOf: [
    { required: ["data"] },
    { required: ["core"] },
    { required: ["skills"] },
    { required: ["projectSkills"] },
    { required: ["wiki"] },
    { required: ["memory"] },
  ],
};

export const METAPROJECT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://metaproject.dev/schemas/metaproject.schema.json",
  title: "Metaproject Manifest",
  type: "object",
  additionalProperties: true,
  required: ["schemaVersion", "standardVersion", "createdBy", "paths", "modules"],
  properties: {
    schemaVersion: { type: "integer", minimum: 1 },
    standardVersion: {
      type: "string",
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.-]+)?$",
    },
    name: { type: "string", minLength: 1 },
    createdBy: { type: "string", minLength: 1 },
    projectType: { type: "string" },
    languages: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    profiles: {
      type: "array",
      items: {
        type: "string",
        enum: ["minimal", "agent", "ci", "full"],
      },
      uniqueItems: true,
    },
    paths: { $ref: "#/$defs/paths" },
    modules: {
      type: "object",
      additionalProperties: { $ref: "module.schema.json" },
    },
    capabilities: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    updatedAt: {
      type: "string",
      format: "date-time",
    },
  },
  $defs: {
    paths: {
      type: "object",
      additionalProperties: { type: "string" },
      required: ["root", "data", "rules", "skills", "modules"],
      properties: {
        root: { type: "string" },
        core: { type: "string" },
        data: { type: "string" },
        rules: { type: "string" },
        skills: { type: "string" },
        projectSkills: { type: "string" },
        modules: { type: "string" },
        reports: { type: "string" },
        templates: { type: "string" },
      },
    },
  },
};

// Registry of named external schema refs used by METAPROJECT_SCHEMA
// (`{ "$ref": "module.schema.json" }`).
export const SCHEMA_REGISTRY: Record<string, JsonSchema> = {
  "module.schema.json": MODULE_SCHEMA,
};
