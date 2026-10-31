# Remote control schemas, readable copies
Version: 0.1.1

Status: planned, normative companion. These are exact JSON copies of the schema files; verify their hashes from the main specification. JSON Schema validates shape; encoded-byte quotas, authorization, message direction, ownership, expiry/state and atomicity are enforced separately.

## machine-protocol.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://keryx.local/schemas/hub-remote-agents/machine-protocol.v1.json",
  "title": "Hub machine protocol v1",
  "description": "Closed application frames. Encoded UTF-8 byte limits, direction, auth, ownership, cursor/epoch and state checks are additional normative requirements. No binary frames.",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "hello"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "const": 0
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "machineId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "ledgerId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "daemonId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "agentVersion": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "capabilities": {
              "type": "array",
              "items": {
                "enum": [
                  "keryx-native-v1"
                ]
              },
              "minItems": 0,
              "maxItems": 16
            },
            "lastHubSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "runCursors": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "runId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                  },
                  "lastLocalSeq": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "runId",
                  "lastLocalSeq"
                ]
              },
              "minItems": 0,
              "maxItems": 1000
            }
          },
          "required": [
            "machineId",
            "ledgerId",
            "daemonId",
            "agentVersion",
            "capabilities",
            "lastHubSequence",
            "runCursors"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "welcome"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "machineId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "heartbeatSeconds": {
              "const": 20
            },
            "heartbeatTimeoutSeconds": {
              "const": 60
            },
            "resumeMode": {
              "enum": [
                "replay",
                "resync-required"
              ]
            },
            "hubSequence": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "machineId",
            "heartbeatSeconds",
            "heartbeatTimeoutSeconds",
            "resumeMode",
            "hubSequence"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "heartbeat"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "daemonId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            }
          },
          "required": [
            "daemonId"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "heartbeat-ack"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "serverTime": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "serverTime"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "inventory"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "inventoryVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "checkouts": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "projectId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                  },
                  "checkoutId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                  },
                  "localBindingId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                  },
                  "label": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "headSha": {
                    "type": "string",
                    "pattern": "^[a-fA-F0-9]{40,64}$"
                  },
                  "clean": {
                    "type": "boolean"
                  },
                  "available": {
                    "type": "boolean"
                  },
                  "busy": {
                    "type": "boolean"
                  },
                  "agentProfiles": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "profileId": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                        },
                        "adapter": {
                          "enum": [
                            "keryx-native-v1"
                          ]
                        },
                        "readiness": {
                          "enum": [
                            "ready",
                            "setup-required",
                            "disabled"
                          ]
                        },
                        "reason": {
                          "enum": [
                            "none",
                            "local-policy",
                            "provider-setup",
                            "containment-missing",
                            "adapter-unsupported",
                            "checkout-unavailable"
                          ]
                        },
                        "capabilityDigest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "policyDigest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      },
                      "required": [
                        "profileId",
                        "adapter",
                        "readiness",
                        "reason",
                        "capabilityDigest",
                        "policyDigest"
                      ]
                    },
                    "minItems": 0,
                    "maxItems": 128
                  }
                },
                "required": [
                  "projectId",
                  "checkoutId",
                  "localBindingId",
                  "label",
                  "headSha",
                  "clean",
                  "available",
                  "busy",
                  "agentProfiles"
                ]
              },
              "minItems": 0,
              "maxItems": 1000
            }
          },
          "required": [
            "inventoryVersion",
            "checkouts"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "command"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "commandId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "hubSequence": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedRunVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "kind": {
                  "const": "start-run"
                },
                "body": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "flowId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "expectedFlowVersion": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "expectedInventoryVersion": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "specDocumentId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "specDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "criteriaDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "expectedHeadSha": {
                      "type": "string",
                      "pattern": "^[a-fA-F0-9]{40,64}$"
                    },
                    "agentProfileId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "capabilityDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "policyDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "prompt": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 32768
                    },
                    "limits": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "maxDurationSeconds": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 1800
                        },
                        "maxOutputBytes": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 10485760
                        }
                      },
                      "required": [
                        "maxDurationSeconds",
                        "maxOutputBytes"
                      ]
                    }
                  },
                  "required": [
                    "flowId",
                    "expectedFlowVersion",
                    "expectedInventoryVersion",
                    "specDocumentId",
                    "specDigest",
                    "criteriaDigest",
                    "expectedHeadSha",
                    "agentProfileId",
                    "capabilityDigest",
                    "policyDigest",
                    "prompt",
                    "limits"
                  ]
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "runId",
                "projectId",
                "checkoutId",
                "expectedRunVersion",
                "expiresAt",
                "authorizedBy",
                "kind",
                "body"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "commandId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "hubSequence": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedRunVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "kind": {
                  "const": "cancel-run"
                },
                "body": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000
                    }
                  },
                  "required": [
                    "reason"
                  ]
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "runId",
                "projectId",
                "checkoutId",
                "expectedRunVersion",
                "expiresAt",
                "authorizedBy",
                "kind",
                "body"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "commandId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "hubSequence": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedRunVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "kind": {
                  "const": "answer-approval"
                },
                "body": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "approvalId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "actionFingerprint": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "policyDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "decision": {
                      "enum": [
                        "allow-once",
                        "deny"
                      ]
                    }
                  },
                  "required": [
                    "approvalId",
                    "actionFingerprint",
                    "policyDigest",
                    "decision"
                  ]
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "runId",
                "projectId",
                "checkoutId",
                "expectedRunVersion",
                "expiresAt",
                "authorizedBy",
                "kind",
                "body"
              ]
            }
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "command-receipt"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "commandId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "hubSequence": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "status": {
              "enum": [
                "received",
                "admitted",
                "rejected",
                "applied",
                "not-applied"
              ]
            },
            "observedRunVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "errorCode": {
              "enum": [
                "none",
                "invalid-frame",
                "unsupported-version",
                "wrong-direction",
                "stale-epoch",
                "unauthorized",
                "forbidden",
                "scope-denied",
                "stale-reference",
                "machine-offline",
                "machine-busy",
                "checkout-dirty",
                "setup-required",
                "command-expired",
                "payload-conflict",
                "approval-expired",
                "approval-not-applied",
                "quota-exceeded",
                "replay-gap",
                "recovery-required",
                "internal-error"
              ]
            }
          },
          "required": [
            "commandId",
            "hubSequence",
            "runId",
            "status",
            "observedRunVersion",
            "errorCode"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "run-event"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "state"
                },
                "state": {
                  "enum": [
                    "dispatching",
                    "received",
                    "starting",
                    "running",
                    "waiting-approval",
                    "paused",
                    "cancelling",
                    "succeeded",
                    "failed",
                    "cancelled",
                    "rejected",
                    "unknown",
                    "lost"
                  ]
                },
                "reasonCode": {
                  "enum": [
                    "none",
                    "invalid-frame",
                    "unsupported-version",
                    "wrong-direction",
                    "stale-epoch",
                    "unauthorized",
                    "forbidden",
                    "scope-denied",
                    "stale-reference",
                    "machine-offline",
                    "machine-busy",
                    "checkout-dirty",
                    "setup-required",
                    "command-expired",
                    "payload-conflict",
                    "approval-expired",
                    "approval-not-applied",
                    "quota-exceeded",
                    "replay-gap",
                    "recovery-required",
                    "internal-error",
                    "control-disconnected",
                    "native-failure",
                    "cancel-too-late",
                    "external-interference"
                  ]
                },
                "nativeIdentity": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "sessionId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "turnId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "daemonId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "supervisorHandleId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    }
                  },
                  "required": [
                    "sessionId",
                    "turnId",
                    "daemonId",
                    "supervisorHandleId"
                  ]
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "state",
                "reasonCode"
              ],
              "allOf": [
                {
                  "if": {
                    "properties": {
                      "state": {
                        "const": "running"
                      }
                    },
                    "required": [
                      "state"
                    ]
                  },
                  "then": {
                    "required": [
                      "nativeIdentity"
                    ]
                  }
                }
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "log"
                },
                "stream": {
                  "enum": [
                    "assistant",
                    "tool-summary",
                    "diagnostic"
                  ]
                },
                "text": {
                  "type": "string",
                  "minLength": 0,
                  "maxLength": 8192
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "stream",
                "text"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "approval-request"
                },
                "approvalId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "actionFingerprint": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "policyDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "summary": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                },
                "localRequired": {
                  "type": "boolean"
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "approvalId",
                "actionFingerprint",
                "policyDigest",
                "expiresAt",
                "summary",
                "localRequired"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "approval-outcome"
                },
                "approvalId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "decision": {
                  "enum": [
                    "allow-once",
                    "deny"
                  ]
                },
                "application": {
                  "enum": [
                    "applied",
                    "not-applied",
                    "expired"
                  ]
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "approvalId",
                "decision",
                "application"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "result-ready"
                },
                "revisionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "partial": {
                  "type": "boolean"
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "revisionId",
                "partial"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "runId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "localSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "observedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "kind": {
                  "const": "log-gap"
                },
                "fromSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "toSeq": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "runId",
                "projectId",
                "checkoutId",
                "localSeq",
                "observedAt",
                "kind",
                "fromSeq",
                "toSeq"
              ]
            }
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "run-event-ack"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "localSeq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "runId",
            "localSeq"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "context-changed"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "projectId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "contextRevision": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "projectId",
            "contextRevision"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "error"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "epoch": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "code": {
              "enum": [
                "invalid-frame",
                "unsupported-version",
                "wrong-direction",
                "stale-epoch",
                "unauthorized",
                "forbidden",
                "scope-denied",
                "stale-reference",
                "machine-offline",
                "machine-busy",
                "checkout-dirty",
                "setup-required",
                "command-expired",
                "payload-conflict",
                "approval-expired",
                "approval-not-applied",
                "quota-exceeded",
                "replay-gap",
                "recovery-required",
                "internal-error"
              ]
            },
            "relatedMessageId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            }
          },
          "required": [
            "code"
          ]
        }
      },
      "required": [
        "v",
        "type",
        "messageId",
        "epoch",
        "payload"
      ]
    }
  ]
}
```

## control-api.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://keryx.local/schemas/hub-remote-agents/control-api.v1.json",
  "title": "Hub remote control request definitions",
  "description": "Validate a named $defs entry for its endpoint; root schema is not an endpoint validator. Encoded byte quotas and authorization are additionally enforced.",
  "$defs": {
    "PairingCreate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "displayName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "projectIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "minItems": 1,
          "maxItems": 1000,
          "uniqueItems": true
        }
      },
      "required": [
        "displayName",
        "projectIds"
      ]
    },
    "EnrollmentRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "code": {
          "type": "string",
          "minLength": 22,
          "maxLength": 256
        },
        "agentVersion": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "ledgerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "code",
        "agentVersion",
        "ledgerId"
      ]
    },
    "MachineRevoke": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "expectedVersion"
      ]
    },
    "StartRunRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "machineId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "checkoutId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "agentProfileId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "flowId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedFlowVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedInventoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHeadSha": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{40,64}$"
        },
        "specDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "criteriaDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "prompt": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        }
      },
      "required": [
        "machineId",
        "checkoutId",
        "agentProfileId",
        "flowId",
        "expectedFlowVersion",
        "expectedInventoryVersion",
        "expectedHeadSha",
        "specDigest",
        "criteriaDigest",
        "capabilityDigest",
        "policyDigest",
        "prompt"
      ]
    },
    "CancelRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000
        }
      },
      "required": [
        "expectedRunVersion",
        "reason"
      ]
    },
    "ApprovalAnswer": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "actionFingerprint": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "decision": {
          "enum": [
            "allow-once",
            "deny"
          ]
        }
      },
      "required": [
        "expectedRunVersion",
        "actionFingerprint",
        "policyDigest",
        "decision"
      ]
    },
    "ResultUpload": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "specDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "gitBaseSha": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{40,64}$"
        },
        "outcome": {
          "enum": [
            "succeeded",
            "failed",
            "cancelled"
          ]
        },
        "partial": {
          "type": "boolean"
        },
        "changes": {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024,
                    "pattern": "^(?!/)(?!.*\\\\)(?!.*(?:^|/)(?:\\.{1,2}|\\.[gG][iI][tT])(?:/|$))(?!.*//)(?!.*/$)[^\\x00-\\x1f\\x7f]+$"
                  },
                  "deleted": {
                    "const": true
                  }
                },
                "required": [
                  "path",
                  "deleted"
                ]
              },
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024,
                    "pattern": "^(?!/)(?!.*\\\\)(?!.*(?:^|/)(?:\\.{1,2}|\\.[gG][iI][tT])(?:/|$))(?!.*//)(?!.*/$)[^\\x00-\\x1f\\x7f]+$"
                  },
                  "contentBase64": {
                    "type": "string",
                    "maxLength": 27962028,
                    "pattern": "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
                  },
                  "mode": {
                    "enum": [
                      "100644",
                      "100755"
                    ]
                  }
                },
                "required": [
                  "path",
                  "contentBase64",
                  "mode"
                ]
              }
            ]
          },
          "minItems": 0,
          "maxItems": 5000
        },
        "checks": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "checkId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "command": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "exitCode": {
                "type": "integer",
                "minimum": 0,
                "maximum": 255
              },
              "output": {
                "type": "string",
                "minLength": 0,
                "maxLength": 1048576
              }
            },
            "required": [
              "checkId",
              "command",
              "exitCode",
              "output"
            ]
          },
          "minItems": 0,
          "maxItems": 100
        }
      },
      "required": [
        "expectedRunVersion",
        "specDigest",
        "gitBaseSha",
        "outcome",
        "partial",
        "changes",
        "checks"
      ]
    },
    "ResolveRunRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "localReconciliationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "decision": {
          "enum": [
            "reconciled",
            "lost"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000
        }
      },
      "required": [
        "runId",
        "expectedRunVersion",
        "localReconciliationId",
        "decision",
        "reason"
      ]
    },
    "LocalMachinePolicy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "const": 1
        },
        "hubId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "enabled": {
          "type": "boolean"
        },
        "maxConcurrentRuns": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "checkouts": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "projectId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "checkoutId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "localBindingId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "path": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "profileIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "minItems": 1,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "projectId",
              "checkoutId",
              "localBindingId",
              "path",
              "profileIds"
            ]
          },
          "minItems": 0,
          "maxItems": 1000
        }
      },
      "required": [
        "version",
        "hubId",
        "enabled",
        "maxConcurrentRuns",
        "checkouts"
      ]
    },
    "BrowserInvalidation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "resource-changed"
        },
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "resource": {
          "enum": [
            "machine",
            "run",
            "approval",
            "context"
          ]
        },
        "resourceId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "version": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "v",
        "type",
        "projectId",
        "resource",
        "resourceId",
        "version"
      ]
    },
    "AuthorizeCommand": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "actionFingerprint": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "runId",
        "commandDigest",
        "policyDigest"
      ]
    },
    "AuthorizationGrant": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "grantId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "authorizedBy": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "authorizedAt": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "actionFingerprint": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "grantId",
        "commandId",
        "runId",
        "commandDigest",
        "authorizedBy",
        "authorizedAt",
        "expiresAt",
        "policyDigest"
      ]
    },
    "ReconciliationReport": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "checkoutId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "ledgerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "daemonId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "observation": {
          "enum": [
            "owned-running",
            "confirmed-stopped",
            "unknown"
          ]
        },
        "observedAt": {
          "type": "string",
          "format": "date-time"
        },
        "nativeIdentity": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "daemonId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "supervisorHandleId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            }
          },
          "required": [
            "sessionId",
            "turnId",
            "daemonId",
            "supervisorHandleId"
          ]
        }
      },
      "required": [
        "runId",
        "projectId",
        "checkoutId",
        "ledgerId",
        "daemonId",
        "commandDigest",
        "expectedRunVersion",
        "observation",
        "observedAt"
      ]
    },
    "ReconciliationReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "reconciliationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "machineId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reportDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "receivedAt": {
          "type": "string",
          "format": "date-time"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "checkoutId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "ledgerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "daemonId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedRunVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "observation": {
          "enum": [
            "owned-running",
            "confirmed-stopped",
            "unknown"
          ]
        }
      },
      "required": [
        "reconciliationId",
        "machineId",
        "reportDigest",
        "receivedAt",
        "runId",
        "projectId",
        "checkoutId",
        "ledgerId",
        "daemonId",
        "expectedRunVersion",
        "observation"
      ]
    },
    "RecoveryPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runs": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "runId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "projectId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "checkoutId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "version": {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              "state": {
                "enum": [
                  "dispatching",
                  "received",
                  "starting",
                  "running",
                  "waiting-approval",
                  "paused",
                  "cancelling",
                  "succeeded",
                  "failed",
                  "cancelled",
                  "rejected",
                  "unknown",
                  "lost"
                ]
              },
              "lastLocalSeq": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "commandDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "specDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "required": [
              "runId",
              "projectId",
              "checkoutId",
              "version",
              "state",
              "lastLocalSeq",
              "commandDigest",
              "specDigest"
            ]
          }
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "hubSequence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "runs",
        "cursor",
        "hasMore",
        "hubSequence"
      ]
    }
  }
}
```

