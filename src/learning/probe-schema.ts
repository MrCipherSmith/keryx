import { validateAgainstSchemaObject } from "../contracts/validator";
import { wilsonInterval } from "../metrics/benchmark";
import { newcombeInterval, verdictForDelta } from "./probe-score";
import type { ProbeScore } from "./probe-score";

export interface ProbeTask {
  id: string;
  kind: "deterministic" | "stochastic";
  prompt: string;
  expect: { file: string; symbol: string };
  goldArtifacts: string[];
}
export interface ProbeTaskSet { schemaVersion: 1; tasks: ProbeTask[] }
export interface ProbeEnvironment {
  model: string; provider: string; commit: string; baseRef: string;
  taskSetDigest: string; baselineDigest: string;
}
export interface ProbePlan {
  schemaVersion: 1; probeId: string; identityDigest: string;
  patternId: string; patternDigest: string; taskId: string; createdAt: string;
  snapshot: { status: "candidate" | "accepted"; trigger: string; action: string };
  environment: ProbeEnvironment;
  request: { runs: number; maxUsd: number | null };
  estimateUsd: number | null;
}
export interface ProbeRun {
  arm: "base" | "probe"; seed: number; answered: boolean; success: boolean; transcript: string;
}
export interface ProbeSeedCheckpoint extends ProbeRun {
  planDigest: string; state: "running" | "completed" | "failed";
  chargedUsd: number; reservedUsd: number;
}
export type ProbeFinalization = { evidence: "applied" | "not-needed" }
  | { evidence: "skipped"; reason: "environment-drift" };
export interface ProbeCheckpoint {
  schemaVersion: 1; probeId: string; planDigest: string; updatedAt: string;
  phase: "running" | "finalizing" | "finalized";
  spendUsd: number; reservedUsd: number; seeds: ProbeSeedCheckpoint[];
  finalization: ProbeFinalization | null;
}
export type ProbeComparison = ProbeScore & {
  schemaVersion: 1; probeId: string; identityDigest: string; patternId: string;
  patternDigest: string; taskId: string; createdAt: string; resumed: boolean;
  environment: ProbeEnvironment; runs: ProbeRun[];
};
export type ProbeValidation<T> = { ok: true; errors: []; value?: T } | { ok: false; errors: string[] };

// Shape snapshots of the four frozen v1 schemas. Local references keep installed
// runtime independent of documentation files. Semantic checks follow below.
const taskSetSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "tasks"
  ],
  "properties": {
    "schemaVersion": {
      "type": "integer",
      "const": 1
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "kind",
          "prompt",
          "expect",
          "goldArtifacts"
        ],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
          },
          "kind": {
            "type": "string",
            "enum": [
              "deterministic",
              "stochastic"
            ]
          },
          "prompt": {
            "type": "string",
            "minLength": 32
          },
          "expect": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "file",
              "symbol"
            ],
            "properties": {
              "file": {
                "type": "string",
                "minLength": 1,
                "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
              },
              "symbol": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "goldArtifacts": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "minLength": 1,
              "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
            },
            "uniqueItems": true
          }
        }
      }
    }
  }
};

const planSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "probeId",
    "identityDigest",
    "patternId",
    "patternDigest",
    "taskId",
    "createdAt",
    "snapshot",
    "environment",
    "request",
    "estimateUsd"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "probeId": {
      "type": "string",
      "pattern": "^[a-f0-9]{12}$"
    },
    "identityDigest": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "patternId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
    },
    "patternDigest": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "taskId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "snapshot": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "trigger",
        "action"
      ],
      "properties": {
        "status": {
          "enum": [
            "candidate",
            "accepted"
          ]
        },
        "trigger": {
          "type": "string",
          "minLength": 8,
          "maxLength": 400
        },
        "action": {
          "type": "string",
          "minLength": 8,
          "maxLength": 400
        }
      }
    },
    "environment": {
      "$ref": "#/$defs/environment"
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "runs",
        "maxUsd"
      ],
      "properties": {
        "runs": {
          "type": "integer",
          "minimum": 1
        },
        "maxUsd": {
          "type": [
            "number",
            "null"
          ],
          "exclusiveMinimum": 0
        }
      }
    },
    "estimateUsd": {
      "type": [
        "number",
        "null"
      ],
      "minimum": 0
    }
  },
  "$defs": {
    "environment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "model",
        "provider",
        "commit",
        "baseRef",
        "taskSetDigest",
        "baselineDigest"
      ],
      "properties": {
        "model": {
          "type": "string",
          "minLength": 1
        },
        "provider": {
          "type": "string",
          "minLength": 1
        },
        "commit": {
          "type": "string",
          "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"
        },
        "baseRef": {
          "type": "string",
          "minLength": 1
        },
        "taskSetDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "baselineDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      }
    },
    "digest": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "relativePath": {
      "type": "string",
      "minLength": 1,
      "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
    }
  }
};

const checkpointSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "probeId",
    "planDigest",
    "updatedAt",
    "phase",
    "spendUsd",
    "reservedUsd",
    "seeds",
    "finalization"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "probeId": {
      "type": "string",
      "pattern": "^[a-f0-9]{12}$"
    },
    "planDigest": {
      "$ref": "#/$defs/plan/$defs/digest"
    },
    "updatedAt": {
      "type": "string",
      "format": "date-time"
    },
    "phase": {
      "enum": [
        "running",
        "finalizing",
        "finalized"
      ]
    },
    "spendUsd": {
      "type": "number",
      "minimum": 0
    },
    "reservedUsd": {
      "type": "number",
      "minimum": 0
    },
    "seeds": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "planDigest",
          "arm",
          "seed",
          "state",
          "transcript",
          "answered",
          "success",
          "chargedUsd",
          "reservedUsd"
        ],
        "properties": {
          "planDigest": {
            "$ref": "#/$defs/plan/$defs/digest"
          },
          "arm": {
            "enum": [
              "base",
              "probe"
            ]
          },
          "seed": {
            "type": "integer",
            "minimum": 0
          },
          "state": {
            "enum": [
              "running",
              "completed",
              "failed"
            ]
          },
          "transcript": {
            "$ref": "#/$defs/plan/$defs/relativePath"
          },
          "answered": {
            "type": "boolean"
          },
          "success": {
            "type": "boolean"
          },
          "chargedUsd": {
            "type": "number",
            "minimum": 0
          },
          "reservedUsd": {
            "type": "number",
            "minimum": 0
          }
        }
      }
    },
    "finalization": {
      "anyOf": [
        {
          "type": "null"
        },
        {
          "$ref": "#/$defs/finalization"
        }
      ]
    }
  },
  "$defs": {
    "finalization": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "evidence"
          ],
          "properties": {
            "evidence": {
              "const": "applied"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "evidence"
          ],
          "properties": {
            "evidence": {
              "const": "not-needed"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "evidence",
            "reason"
          ],
          "properties": {
            "evidence": {
              "const": "skipped"
            },
            "reason": {
              "const": "environment-drift"
            }
          }
        }
      ]
    },
    "plan": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "probeId",
        "identityDigest",
        "patternId",
        "patternDigest",
        "taskId",
        "createdAt",
        "snapshot",
        "environment",
        "request",
        "estimateUsd"
      ],
      "properties": {
        "schemaVersion": {
          "const": 1
        },
        "probeId": {
          "type": "string",
          "pattern": "^[a-f0-9]{12}$"
        },
        "identityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "patternId": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
        },
        "patternDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "taskId": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "snapshot": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "trigger",
            "action"
          ],
          "properties": {
            "status": {
              "enum": [
                "candidate",
                "accepted"
              ]
            },
            "trigger": {
              "type": "string",
              "minLength": 8,
              "maxLength": 400
            },
            "action": {
              "type": "string",
              "minLength": 8,
              "maxLength": 400
            }
          }
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "request": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "runs",
            "maxUsd"
          ],
          "properties": {
            "runs": {
              "type": "integer",
              "minimum": 1
            },
            "maxUsd": {
              "type": [
                "number",
                "null"
              ],
              "exclusiveMinimum": 0
            }
          }
        },
        "estimateUsd": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        }
      },
      "$defs": {
        "environment": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "model",
            "provider",
            "commit",
            "baseRef",
            "taskSetDigest",
            "baselineDigest"
          ],
          "properties": {
            "model": {
              "type": "string",
              "minLength": 1
            },
            "provider": {
              "type": "string",
              "minLength": 1
            },
            "commit": {
              "type": "string",
              "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"
            },
            "baseRef": {
              "type": "string",
              "minLength": 1
            },
            "taskSetDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "baselineDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          }
        },
        "digest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "relativePath": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
        }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "phase": {
            "const": "finalized"
          }
        }
      },
      "then": {
        "properties": {
          "finalization": {
            "$ref": "#/$defs/finalization"
          },
          "reservedUsd": {
            "const": 0
          }
        }
      },
      "else": {
        "properties": {
          "finalization": {
            "type": "null"
          }
        }
      }
    }
  ]
};

const comparisonSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "probeId",
    "identityDigest",
    "patternId",
    "patternDigest",
    "taskId",
    "createdAt",
    "resumed",
    "environment",
    "arms",
    "delta",
    "verdict",
    "runs"
  ],
  "properties": {
    "schemaVersion": {
      "const": 1
    },
    "probeId": {
      "type": "string",
      "pattern": "^[a-f0-9]{12}$"
    },
    "identityDigest": {
      "$ref": "#/$defs/plan/$defs/digest"
    },
    "patternId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
    },
    "patternDigest": {
      "$ref": "#/$defs/plan/$defs/digest"
    },
    "taskId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "resumed": {
      "type": "boolean"
    },
    "environment": {
      "$ref": "#/$defs/plan/$defs/environment"
    },
    "arms": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "base",
        "probe"
      ],
      "properties": {
        "base": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "seeds",
                "successes",
                "rate",
                "ci"
              ],
              "properties": {
                "seeds": {
                  "type": "integer",
                  "minimum": 1
                },
                "successes": {
                  "type": "integer",
                  "minimum": 0
                },
                "rate": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "ci": {
                  "type": "array",
                  "minItems": 2,
                  "items": {
                    "type": "number",
                    "minimum": -1,
                    "maximum": 1
                  },
                  "maxItems": 2
                },
                "tokens": {
                  "type": "integer",
                  "minimum": 0
                },
                "toolCalls": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            {
              "type": "null"
            }
          ]
        },
        "probe": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "seeds",
                "successes",
                "rate",
                "ci"
              ],
              "properties": {
                "seeds": {
                  "type": "integer",
                  "minimum": 1
                },
                "successes": {
                  "type": "integer",
                  "minimum": 0
                },
                "rate": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "ci": {
                  "type": "array",
                  "minItems": 2,
                  "items": {
                    "type": "number",
                    "minimum": -1,
                    "maximum": 1
                  },
                  "maxItems": 2
                },
                "tokens": {
                  "type": "integer",
                  "minimum": 0
                },
                "toolCalls": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            {
              "type": "null"
            }
          ]
        }
      }
    },
    "delta": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "rate",
            "ci"
          ],
          "properties": {
            "rate": {
              "type": "number",
              "minimum": -1,
              "maximum": 1
            },
            "ci": {
              "type": "array",
              "minItems": 2,
              "items": {
                "type": "number",
                "minimum": -1,
                "maximum": 1
              },
              "maxItems": 2
            },
            "tokens": {
              "type": "integer"
            },
            "toolCalls": {
              "type": "integer"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "verdict": {
      "enum": [
        "improved",
        "regressed",
        "indistinguishable",
        "unmeasurable"
      ]
    },
    "reason": {
      "enum": [
        "no-task",
        "gold-leak",
        "run-failed",
        "underpowered",
        "budget-exceeded",
        "environment-drift"
      ]
    },
    "runs": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "arm",
          "seed",
          "answered",
          "success",
          "transcript"
        ],
        "properties": {
          "arm": {
            "enum": [
              "base",
              "probe"
            ]
          },
          "seed": {
            "type": "integer",
            "minimum": 0
          },
          "answered": {
            "type": "boolean"
          },
          "success": {
            "type": "boolean"
          },
          "transcript": {
            "$ref": "#/$defs/plan/$defs/relativePath"
          }
        }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "verdict": {
            "const": "unmeasurable"
          }
        }
      },
      "then": {
        "required": [
          "reason"
        ],
        "properties": {
          "arms": {
            "properties": {
              "base": {
                "type": "null"
              },
              "probe": {
                "type": "null"
              }
            }
          },
          "delta": {
            "type": "null"
          }
        }
      },
      "else": {
        "not": {
          "required": [
            "reason"
          ]
        },
        "properties": {
          "arms": {
            "properties": {
              "base": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "seeds",
                  "successes",
                  "rate",
                  "ci"
                ],
                "properties": {
                  "seeds": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "successes": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "rate": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  "ci": {
                    "type": "array",
                    "minItems": 2,
                    "items": {
                      "type": "number",
                      "minimum": -1,
                      "maximum": 1
                    },
                    "maxItems": 2
                  },
                  "tokens": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "toolCalls": {
                    "type": "integer",
                    "minimum": 0
                  }
                }
              },
              "probe": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "seeds",
                  "successes",
                  "rate",
                  "ci"
                ],
                "properties": {
                  "seeds": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "successes": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "rate": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  "ci": {
                    "type": "array",
                    "minItems": 2,
                    "items": {
                      "type": "number",
                      "minimum": -1,
                      "maximum": 1
                    },
                    "maxItems": 2
                  },
                  "tokens": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "toolCalls": {
                    "type": "integer",
                    "minimum": 0
                  }
                }
              }
            }
          },
          "delta": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "rate",
              "ci"
            ],
            "properties": {
              "rate": {
                "type": "number",
                "minimum": -1,
                "maximum": 1
              },
              "ci": {
                "type": "array",
                "minItems": 2,
                "items": {
                  "type": "number",
                  "minimum": -1,
                  "maximum": 1
                },
                "maxItems": 2
              },
              "tokens": {
                "type": "integer"
              },
              "toolCalls": {
                "type": "integer"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "required": [
          "reason"
        ],
        "properties": {
          "reason": {
            "enum": [
              "no-task",
              "underpowered",
              "gold-leak"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "runs": {
            "maxItems": 0
          }
        }
      }
    }
  ],
  "$defs": {
    "plan": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "probeId",
        "identityDigest",
        "patternId",
        "patternDigest",
        "taskId",
        "createdAt",
        "snapshot",
        "environment",
        "request",
        "estimateUsd"
      ],
      "properties": {
        "schemaVersion": {
          "const": 1
        },
        "probeId": {
          "type": "string",
          "pattern": "^[a-f0-9]{12}$"
        },
        "identityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "patternId": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
        },
        "patternDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "taskId": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]{0,127}$"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "snapshot": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "trigger",
            "action"
          ],
          "properties": {
            "status": {
              "enum": [
                "candidate",
                "accepted"
              ]
            },
            "trigger": {
              "type": "string",
              "minLength": 8,
              "maxLength": 400
            },
            "action": {
              "type": "string",
              "minLength": 8,
              "maxLength": 400
            }
          }
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "request": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "runs",
            "maxUsd"
          ],
          "properties": {
            "runs": {
              "type": "integer",
              "minimum": 1
            },
            "maxUsd": {
              "type": [
                "number",
                "null"
              ],
              "exclusiveMinimum": 0
            }
          }
        },
        "estimateUsd": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0
        }
      },
      "$defs": {
        "environment": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "model",
            "provider",
            "commit",
            "baseRef",
            "taskSetDigest",
            "baselineDigest"
          ],
          "properties": {
            "model": {
              "type": "string",
              "minLength": 1
            },
            "provider": {
              "type": "string",
              "minLength": 1
            },
            "commit": {
              "type": "string",
              "pattern": "^(?:[a-f0-9]{40}|[a-f0-9]{64})$"
            },
            "baseRef": {
              "type": "string",
              "minLength": 1
            },
            "taskSetDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "baselineDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          }
        },
        "digest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "relativePath": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.(?:/|$)).+$"
        }
      }
    }
  }
};

function shape<T>(schema: Record<string, unknown>, value: unknown): ProbeValidation<T> {
  const result = validateAgainstSchemaObject(schema, value);
  return result.valid ? { ok: true, errors: [] } : { ok: false, errors: result.errors.map((e) => `${e.path}: ${e.message}`) };
}
function result<T>(errors: string[]): ProbeValidation<T> {
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
/** Lexical containment only. Symlink/realpath and base-ref checks belong to the runner. */
export function isProbeRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:/.test(value)
    && !value.includes("\\") && !value.split("/").includes("..")
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function paths(paths: string[], errors: string[]): void {
  if (paths.some((p) => !isProbeRelativePath(p))) errors.push("path: unsafe repository-relative path");
}
function runs(runs: ProbeRun[], errors: string[]): void {
  const seen = new Set<string>();
  for (const run of runs) {
    const key = `${run.arm}:${run.seed}`;
    if (seen.has(key)) errors.push("runs: duplicate arm/seed");
    seen.add(key);
    if (!Number.isSafeInteger(run.seed)) errors.push("seed: must be a safe integer");
    if (run.success && !run.answered) errors.push("success requires answered");
    paths([run.transcript], errors);
  }
}
export function validateProbeTaskSet(value: unknown): ProbeValidation<ProbeTaskSet> {
  const checked = shape<ProbeTaskSet>(taskSetSchema, value);
  if (!checked.ok) return checked;
  const set = value as ProbeTaskSet;
  const errors: string[] = [];
  if (new Set(set.tasks.map((t) => t.id)).size !== set.tasks.length) errors.push("tasks: duplicate id");
  for (const task of set.tasks) paths([task.expect.file, ...task.goldArtifacts], errors);
  return result(errors);
}
export function validateProbePlan(value: unknown, options: { persisted?: boolean } = {}): ProbeValidation<ProbePlan> {
  const checked = shape<ProbePlan>(planSchema, value);
  if (!checked.ok) return checked;
  const plan = value as ProbePlan;
  const errors: string[] = [];
  if (!Number.isSafeInteger(plan.request.runs)) errors.push("request.runs: must be a safe integer");
  if (options.persisted && plan.request.maxUsd === null) errors.push("request.maxUsd: persisted plan requires a positive budget");
  if (plan.probeId !== plan.identityDigest.slice(0, 12)) errors.push("probeId: identity digest prefix mismatch");
  return result(errors);
}
export function validateProbeCheckpoint(value: unknown): ProbeValidation<ProbeCheckpoint> {
  const checked = shape<ProbeCheckpoint>(checkpointSchema, value);
  if (!checked.ok) return checked;
  const checkpoint = value as ProbeCheckpoint;
  const errors: string[] = [];
  runs(checkpoint.seeds, errors);
  for (const seed of checkpoint.seeds) {
    if (seed.planDigest !== checkpoint.planDigest) errors.push("seed.planDigest: checkpoint link mismatch");
    if (seed.state !== "completed" && seed.success) errors.push("seed.success: requires completed state");
    if (seed.state !== "running" && seed.reservedUsd !== 0) errors.push("seed.reservedUsd: finished seed cannot retain reservation");
    if (checkpoint.phase !== "running" && seed.state === "running") errors.push("phase: cannot finalize running seed");
  }
  return result(errors);
}
function close(a: number, b: number): boolean { return Math.abs(a - b) <= 1e-12; }
function intervalEqual(a: [number, number], b: [number, number]): boolean {
  return close(a[0], b[0]) && close(a[1], b[1]);
}
export function validateProbeComparison(value: unknown): ProbeValidation<ProbeComparison> {
  const checked = shape<ProbeComparison>(comparisonSchema, value);
  if (!checked.ok) return checked;
  const comparison = value as ProbeComparison;
  const errors: string[] = [];
  runs(comparison.runs, errors);
  if (comparison.probeId !== comparison.identityDigest.slice(0, 12)) errors.push("probeId: identity digest prefix mismatch");
  if (comparison.verdict === "unmeasurable") return result(errors);
  const { base, probe } = comparison.arms;
  if (base.seeds !== probe.seeds) errors.push("arms: unequal seed counts");
  for (const arm of ["base", "probe"] as const) {
    const score = comparison.arms[arm];
    const armRuns = comparison.runs.filter((r) => r.arm === arm);
    if (armRuns.length !== score.seeds || armRuns.some((r) => !r.answered || r.seed >= score.seeds)
      || armRuns.filter((r) => r.success).length !== score.successes) errors.push(`${arm}: inconsistent runs/counts`);
    const expected = wilsonInterval(score.successes, score.seeds);
    if (!expected || !close(score.rate, expected.rate) || !intervalEqual(score.ci, [expected.lower, expected.upper])) errors.push(`${arm}: inconsistent Wilson interval`);
  }
  const expected = newcombeInterval(base, probe);
  if (!expected || !close(comparison.delta.rate, expected.rate) || !intervalEqual(comparison.delta.ci, expected.ci)
    || comparison.verdict !== verdictForDelta(comparison.delta.ci)) errors.push("delta: inconsistent rate/interval/verdict");
  for (const key of ["tokens", "toolCalls"] as const) {
    const expected = base[key] === undefined || probe[key] === undefined ? undefined : probe[key] - base[key];
    if (comparison.delta[key] !== expected) errors.push(`delta.${key}: inconsistent telemetry`);
  }
  return result(errors);
}
