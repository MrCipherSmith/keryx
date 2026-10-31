# Persistent session control schemas, readable copies
Version: 0.2.0

Status: planned, normative companion to [protocol.md](protocol.md). These are exact JSON copies. HTTP schemas are a definition collection: select the endpoint’s named `$defs`; the root is not an endpoint validator. Closed envelopes and bounded JSON carriers do not replace selected command field validation, byte/depth quotas, authorization, direction, ownership, expiry, leases, state transitions or atomicity. ArgumentSchema maps and BoundedJson objects are intentionally dynamic only within the published command schema; no arbitrary route, shell, external reference or executable validator is accepted.

## machine-protocol.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://keryx.local/schemas/hub-remote-sessions/machine-protocol.v2.json",
  "title": "Hub machine protocol v2",
  "description": "Closed application frames. Encoded UTF-8 byte limits, direction, auth, ownership, cursor/epoch and state checks are additional normative requirements. No binary frames.",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 2
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
            },
            "sessionCursors": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "sessionId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                  },
                  "lastSessionEventSeq": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "sessionId",
                  "lastSessionEventSeq"
                ]
              },
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
            "runCursors",
            "sessionCursors"
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
          "const": 2
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
          "const": 2
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
          "const": 2
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
          "const": 2
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
          "const": 2
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
                  "const": "start-turn"
                },
                "body": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "request": {
                      "$ref": "#/$defs/StartTurnRequest"
                    },
                    "snapshot": {
                      "$ref": "#/$defs/ConfigSnapshot"
                    },
                    "turnOrdinal": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "request",
                    "snapshot",
                    "turnOrdinal"
                  ]
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedSessionVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "controller": {
                  "$ref": "#/$defs/ControllerBinding"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
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
                "body",
                "sessionId",
                "turnId",
                "expectedSessionVersion",
                "controller",
                "commandDigest"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedSessionVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "controller": {
                  "$ref": "#/$defs/ControllerBinding"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
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
                "body",
                "sessionId",
                "turnId",
                "expectedSessionVersion",
                "controller",
                "commandDigest"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expectedSessionVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                },
                "controller": {
                  "$ref": "#/$defs/ControllerBinding"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
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
                "body",
                "sessionId",
                "turnId",
                "expectedSessionVersion",
                "controller",
                "commandDigest"
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
          "const": 2
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
            },
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            }
          },
          "required": [
            "commandId",
            "hubSequence",
            "runId",
            "status",
            "observedRunVersion",
            "errorCode",
            "sessionId"
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
          "const": 2
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "reasonCode",
                "sessionId",
                "turnId"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "text",
                "sessionId",
                "turnId"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "localRequired",
                "sessionId",
                "turnId"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "application",
                "sessionId",
                "turnId"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "partial",
                "sessionId",
                "turnId"
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
                },
                "sessionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "turnId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
                "toSeq",
                "sessionId",
                "turnId"
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
          "const": 2
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
          "const": 2
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
          "const": 2
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
                "internal-error",
                "session-busy",
                "session-closed",
                "controller-conflict",
                "controller-expired",
                "stale-version",
                "invalid-arguments",
                "stale-catalogue",
                "unknown-command",
                "confirmation-required",
                "workspace-conflict",
                "ad-hoc-forbidden"
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
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 2
        },
        "type": {
          "const": "session-command"
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "create-session"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/SessionCreate"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "resume-session"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/SessionResume"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "fork-session"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "newSessionId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                    },
                    "request": {
                      "$ref": "#/$defs/SessionFork"
                    }
                  },
                  "required": [
                    "newSessionId",
                    "request"
                  ]
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "close-session"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/SessionClose"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "submit-message"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/MessageSubmit"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "edit-queue"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/QueueEdit"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "remove-queue"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/QueueRemove"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "invoke-command"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/CommandInvoke"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "change-config"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/ConfigChange"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "claim-controller"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/ControllerClaim"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "release-controller"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/ControllerRelease"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "confirm-command"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/CommandConfirmation"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
                "projectId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "checkoutId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "target": {
                  "$ref": "#/$defs/CommandTarget"
                },
                "kind": {
                  "const": "reauthorize-queue"
                },
                "authorizedBy": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "commandDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "body": {
                  "$ref": "#/$defs/QueueReauthorize"
                }
              },
              "required": [
                "commandId",
                "hubSequence",
                "projectId",
                "checkoutId",
                "target",
                "kind",
                "authorizedBy",
                "expiresAt",
                "commandDigest",
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
          "const": 2
        },
        "type": {
          "const": "session-command-receipt"
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
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "observedSessionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "status": {
              "enum": [
                "received",
                "admitted",
                "rejected",
                "applied",
                "not-applied",
                "unknown"
              ]
            },
            "receiptId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "errorCode": {
              "anyOf": [
                {
                  "enum": [
                    "session-busy",
                    "session-closed",
                    "controller-conflict",
                    "controller-expired",
                    "stale-version",
                    "invalid-arguments",
                    "stale-catalogue",
                    "unknown-command",
                    "confirmation-required",
                    "workspace-conflict",
                    "ad-hoc-forbidden",
                    "command-expired",
                    "scope-denied",
                    "payload-conflict",
                    "recovery-required"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "commandId",
            "hubSequence",
            "sessionId",
            "observedSessionVersion",
            "status",
            "receiptId",
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
          "const": 2
        },
        "type": {
          "const": "session-event"
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
          "$ref": "#/$defs/SessionEvent"
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
          "const": 2
        },
        "type": {
          "const": "session-event-ack"
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
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "sessionId",
            "sessionEventSeq"
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
          "const": 2
        },
        "type": {
          "const": "capability-page"
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
          "$ref": "#/$defs/CapabilityPage"
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
  ],
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
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        }
      },
      "required": [
        "sessionId",
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline",
        "association",
        "messageId",
        "text"
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
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedRunVersion",
        "reason",
        "expectedSessionVersion",
        "controller"
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
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedRunVersion",
        "actionFingerprint",
        "policyDigest",
        "decision",
        "expectedSessionVersion",
        "controller"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "workspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "expectedRunVersion",
        "gitBaseSha",
        "outcome",
        "partial",
        "changes",
        "checks",
        "sessionId",
        "turnId",
        "association",
        "workspaceBaseline"
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
          "const": 2
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
        },
        "allowAdHocSessions": {
          "type": "boolean"
        },
        "allowedCandidateIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "maxItems": 128,
          "uniqueItems": true
        },
        "profiles": {
          "type": "array",
          "maxItems": 128,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "profileId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "allowAdHocTurns": {
                "type": "boolean"
              },
              "consentVersion": {
                "type": "integer",
                "minimum": 1
              },
              "allowedCandidateIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "profileId",
              "allowAdHocTurns",
              "consentVersion",
              "allowedCandidateIds"
            ]
          }
        }
      },
      "required": [
        "version",
        "hubId",
        "enabled",
        "maxConcurrentRuns",
        "checkouts",
        "allowAdHocSessions",
        "allowedCandidateIds",
        "profiles"
      ]
    },
    "BrowserInvalidation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 2
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
            "context",
            "session",
            "history",
            "queue",
            "command-catalogue",
            "config",
            "controller"
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
        },
        "target": {
          "$ref": "#/$defs/CommandTarget"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerBinding"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "commandDigest",
        "policyDigest",
        "target",
        "controller"
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
        },
        "target": {
          "$ref": "#/$defs/CommandTarget"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerBinding"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "grantId",
        "commandId",
        "commandDigest",
        "authorizedBy",
        "authorizedAt",
        "expiresAt",
        "policyDigest",
        "target",
        "controller"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "observedAt",
        "sessionId",
        "turnId"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "observation",
        "sessionId",
        "turnId"
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
              "sessionId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "turnId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "association": {
                "$ref": "#/$defs/FlowAssociation"
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
              "sessionId",
              "turnId",
              "association"
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
        },
        "sessions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionRecord"
          },
          "maxItems": 100
        }
      },
      "required": [
        "runs",
        "cursor",
        "hasMore",
        "hubSequence",
        "sessions"
      ]
    },
    "FlowAssociation": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "flow"
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
            "specDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "criteriaDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "mode",
            "flowId",
            "expectedFlowVersion",
            "specDigest",
            "criteriaDigest"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "ad-hoc"
            },
            "profileConsentVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "mode",
            "profileConsentVersion"
          ]
        }
      ]
    },
    "ControllerBinding": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedControllerVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "controllerLeaseId",
        "expectedControllerVersion"
      ]
    },
    "ControllerLease": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "actorId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "actorKind": {
          "const": "human-operator"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "state": {
          "enum": [
            "held",
            "released",
            "expired"
          ]
        }
      },
      "required": [
        "controllerLeaseId",
        "sessionId",
        "version",
        "actorId",
        "actorKind",
        "expiresAt",
        "state"
      ]
    },
    "SessionMutationBase": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller"
      ]
    },
    "SessionCreate": {
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
        "expectedInventoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHeadSha": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{40,64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "title": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "machineId",
        "checkoutId",
        "agentProfileId",
        "expectedInventoryVersion",
        "expectedHeadSha",
        "capabilityDigest",
        "policyDigest",
        "title"
      ]
    },
    "SessionOpen": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "expectedSessionVersion"
      ]
    },
    "SessionResume": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline"
      ]
    },
    "SessionFork": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "throughHistoryCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "targetCheckoutId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "title": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "throughHistoryCursor",
        "expectedHistoryVersion",
        "targetCheckoutId",
        "expectedInventoryVersion",
        "expectedHeadSha",
        "title"
      ]
    },
    "SessionClose": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "mode": {
          "enum": [
            "when-idle",
            "cancel-and-close"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "mode"
      ]
    },
    "ControllerClaim": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedControllerVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "requestedLeaseSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60
        },
        "mode": {
          "enum": [
            "claim",
            "renew",
            "takeover"
          ]
        },
        "previousReleaseReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "expectedControllerVersion",
        "requestedLeaseSeconds",
        "mode"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "mode": {
                "const": "takeover"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "required": [
              "previousReleaseReceiptId"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "mode": {
                "const": "renew"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "required": [
              "controllerLeaseId"
            ]
          }
        }
      ]
    },
    "ControllerRelease": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller"
      ]
    },
    "ControllerReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "lease": {
          "$ref": "#/$defs/ControllerLease"
        }
      },
      "required": [
        "receiptId",
        "sessionVersion",
        "lease"
      ]
    },
    "RoutingConfig": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "profileId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "candidateIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "fallbackCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "enabled",
        "profileId",
        "candidateIds",
        "fallbackCandidateId"
      ]
    },
    "SessionConfig": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "configVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "baselineCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEffort": {
          "enum": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        },
        "routing": {
          "$ref": "#/$defs/RoutingConfig"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "configVersion",
        "baselineCandidateId",
        "reasoningEffort",
        "routing",
        "policyDigest",
        "capabilityDigest"
      ]
    },
    "ConfigSnapshot": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "config": {
          "$ref": "#/$defs/SessionConfig"
        },
        "configDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "effectiveCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "routingDecision": {
          "enum": [
            "baseline",
            "classified",
            "classifier-fallback"
          ]
        },
        "fallbackReason": {
          "enum": [
            "none",
            "classifier-failed",
            "candidate-unavailable",
            "policy-denied"
          ]
        },
        "selectionReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "config",
        "configDigest",
        "effectiveCandidateId",
        "routingDecision",
        "fallbackReason",
        "selectionReceiptId"
      ]
    },
    "RoutingCandidate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "candidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "providerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "modelId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEfforts": {
          "type": "array",
          "items": {
            "enum": [
              "none",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ]
          },
          "maxItems": 8
        },
        "available": {
          "type": "boolean"
        },
        "reason": {
          "enum": [
            "none",
            "not-connected",
            "local-policy",
            "budget",
            "consent-required"
          ]
        },
        "privacyClass": {
          "enum": [
            "local",
            "approved-egress"
          ]
        },
        "costClass": {
          "enum": [
            "local",
            "metered"
          ]
        }
      },
      "required": [
        "candidateId",
        "providerId",
        "modelId",
        "reasoningEfforts",
        "available",
        "reason",
        "privacyClass",
        "costClass"
      ]
    },
    "RoutingAvailability": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "candidates": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RoutingCandidate"
          },
          "maxItems": 128
        },
        "profileIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "maxItems": 128
        }
      },
      "required": [
        "version",
        "policyDigest",
        "capabilityDigest",
        "candidates",
        "profileIds"
      ]
    },
    "ConfigChange": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "baselineCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEffort": {
          "enum": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        },
        "routing": {
          "$ref": "#/$defs/RoutingConfig"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "baselineCandidateId",
        "reasoningEffort",
        "routing",
        "busyPolicy"
      ]
    },
    "ConfigReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "status": {
          "enum": [
            "queued",
            "applied",
            "rejected",
            "confirmation-required"
          ]
        },
        "configVersion": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "effectiveFromTurnOrdinal": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "none",
            "busy",
            "stale-version",
            "policy-changed",
            "confirmation-required",
            "candidate-unavailable"
          ]
        },
        "confirmation": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommandConfirmationRequest"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "receiptId",
        "operationId",
        "sessionId",
        "sessionVersion",
        "status",
        "configVersion",
        "effectiveFromTurnOrdinal",
        "reason",
        "confirmation"
      ]
    },
    "SessionRecord": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
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
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "historyVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "opening",
            "idle",
            "busy",
            "paused",
            "closed",
            "recovery-required"
          ]
        },
        "title": {
          "type": "string",
          "maxLength": 200
        },
        "config": {
          "$ref": "#/$defs/SessionConfig"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerLease"
            },
            {
              "type": "null"
            }
          ]
        },
        "activeRunId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "activeTurnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "nextTurnOrdinal": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "historyCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sessionEventCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "queueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "workspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "forkedFromSessionId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "capabilities": {
          "$ref": "#/$defs/SessionCapabilities"
        }
      },
      "required": [
        "sessionId",
        "projectId",
        "machineId",
        "checkoutId",
        "agentProfileId",
        "version",
        "historyVersion",
        "state",
        "title",
        "config",
        "controller",
        "activeRunId",
        "activeTurnId",
        "nextTurnOrdinal",
        "historyCursor",
        "sessionEventCursor",
        "queueVersion",
        "workspaceBaseline",
        "forkedFromSessionId",
        "capabilities"
      ]
    },
    "SessionPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionRecord"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        }
      },
      "required": [
        "sessions",
        "cursor",
        "hasMore"
      ]
    },
    "SessionMessage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "historyCursor": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "role": {
          "enum": [
            "human",
            "assistant",
            "tool-summary",
            "system-receipt"
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "messageId",
        "sessionId",
        "historyCursor",
        "role",
        "text",
        "createdAt",
        "turnId",
        "runId"
      ]
    },
    "HistoryPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "messages": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionMessage"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "historyVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "retainedFromCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "gap": {
          "type": "boolean"
        }
      },
      "required": [
        "messages",
        "cursor",
        "hasMore",
        "historyVersion",
        "retainedFromCursor",
        "gap"
      ]
    },
    "MessageSubmit": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "interpretation": {
          "const": "literal-message"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "enqueue"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "text",
        "interpretation",
        "association",
        "busyPolicy"
      ]
    },
    "TurnReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "queueItemId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "status": {
          "enum": [
            "queued",
            "admitted",
            "rejected"
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnOrdinal": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "operationId",
        "messageId",
        "sessionId",
        "sessionVersion",
        "queueItemId",
        "status",
        "runId",
        "turnId",
        "turnOrdinal"
      ]
    },
    "QueueItem": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "kind": {
          "enum": [
            "message",
            "command",
            "config"
          ]
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "state": {
          "enum": [
            "queued",
            "admitted",
            "applied",
            "rejected",
            "removed",
            "suspended"
          ]
        },
        "position": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "text": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 32768
            },
            {
              "type": "null"
            }
          ]
        },
        "commandName": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "replacesOperationId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "queueItemId",
        "version",
        "kind",
        "operationId",
        "state",
        "position",
        "text",
        "commandName",
        "expectedConfigVersion",
        "replacesOperationId"
      ]
    },
    "QueuePage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/QueueItem"
          },
          "maxItems": 100
        },
        "queueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        }
      },
      "required": [
        "items",
        "queueVersion",
        "cursor",
        "hasMore"
      ]
    },
    "QueueEdit": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "text",
        "queueItemId"
      ]
    },
    "QueueRemove": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "queueItemId"
      ]
    },
    "BoundedJson": {
      "oneOf": [
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "number"
        },
        {
          "type": "string",
          "maxLength": 32768
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/BoundedJson"
          },
          "maxItems": 128
        },
        {
          "type": "object",
          "maxProperties": 64,
          "propertyNames": {
            "type": "string",
            "maxLength": 100
          },
          "additionalProperties": {
            "$ref": "#/$defs/BoundedJson"
          }
        }
      ]
    },
    "ArgumentSchema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "string"
            },
            "maxLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 32768
            },
            "enum": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 32768
              },
              "minItems": 1,
              "maxItems": 128,
              "uniqueItems": true
            }
          },
          "required": [
            "type",
            "maxLength"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "enum": [
                "integer",
                "number"
              ]
            },
            "minimum": {
              "type": "number"
            },
            "maximum": {
              "type": "number"
            }
          },
          "required": [
            "type",
            "minimum",
            "maximum"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "enum": [
                "boolean",
                "null"
              ]
            }
          },
          "required": [
            "type"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "array"
            },
            "items": {
              "$ref": "#/$defs/ArgumentSchema"
            },
            "maxItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 128
            }
          },
          "required": [
            "type",
            "items",
            "maxItems"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "object"
            },
            "additionalProperties": {
              "const": false
            },
            "properties": {
              "type": "object",
              "maxProperties": 64,
              "propertyNames": {
                "type": "string",
                "maxLength": 100
              },
              "additionalProperties": {
                "$ref": "#/$defs/ArgumentSchema"
              }
            },
            "required": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 100
              },
              "maxItems": 64,
              "uniqueItems": true
            }
          },
          "required": [
            "type",
            "additionalProperties",
            "properties",
            "required"
          ]
        }
      ]
    },
    "CommandCatalogueEntry": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "summary": {
          "type": "string",
          "maxLength": 1000
        },
        "handlerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "inputSchema": {
          "$ref": "#/$defs/ArgumentSchema"
        },
        "resultSchema": {
          "$ref": "#/$defs/ArgumentSchema"
        },
        "mutationClass": {
          "enum": [
            "read",
            "session",
            "workspace",
            "sensitive-setup"
          ]
        },
        "states": {
          "type": "array",
          "items": {
            "enum": [
              "idle",
              "busy",
              "paused",
              "closed"
            ]
          },
          "maxItems": 3
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle",
            "read-only"
          ]
        },
        "confirmation": {
          "enum": [
            "none",
            "human",
            "local-only"
          ]
        },
        "availability": {
          "enum": [
            "available",
            "setup-required",
            "policy-denied",
            "implementation-gap"
          ]
        },
        "reason": {
          "type": "string",
          "maxLength": 1000
        }
      },
      "required": [
        "commandName",
        "summary",
        "handlerId",
        "inputSchema",
        "resultSchema",
        "mutationClass",
        "states",
        "busyPolicy",
        "confirmation",
        "availability",
        "reason"
      ]
    },
    "CommandCatalogue": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "catalogueVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "catalogueDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/CommandCatalogueEntry"
          },
          "maxItems": 1000
        }
      },
      "required": [
        "catalogueVersion",
        "catalogueDigest",
        "capabilityDigest",
        "entries"
      ]
    },
    "CommandInvoke": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "catalogueDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "arguments": {
          "$ref": "#/$defs/BoundedJson"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle"
          ]
        },
        "confirmationReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "catalogueDigest",
        "commandName",
        "arguments",
        "busyPolicy"
      ]
    },
    "CommandOutcome": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "status": {
          "enum": [
            "queued",
            "applied",
            "rejected",
            "confirmation-required",
            "recovery-required"
          ]
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "result": {
          "$ref": "#/$defs/BoundedJson"
        },
        "confirmationId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "errorCode": {
          "anyOf": [
            {
              "enum": [
                "invalid-arguments",
                "stale-catalogue",
                "busy",
                "forbidden",
                "confirmation-expired",
                "policy-changed",
                "unknown-command",
                "implementation-gap"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "confirmation": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommandConfirmationRequest"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "operationId",
        "sessionId",
        "commandName",
        "status",
        "sessionVersion",
        "result",
        "confirmationId",
        "errorCode",
        "confirmation",
        "runId",
        "turnId"
      ]
    },
    "CommandConfirmation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "confirmationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationDigest": {
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
        "expectedSessionVersion",
        "controller",
        "confirmationId",
        "operationDigest",
        "policyDigest",
        "decision"
      ]
    },
    "StartTurnRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        }
      },
      "required": [
        "sessionId",
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline",
        "association",
        "messageId",
        "text"
      ]
    },
    "ResultReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "revisionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "checksKind": {
          "enum": [
            "FlowEvidence",
            "RunChecks"
          ]
        },
        "flowId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "evidenceId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "partial": {
          "type": "boolean"
        }
      },
      "required": [
        "receiptId",
        "runId",
        "turnId",
        "sessionId",
        "revisionId",
        "checksKind",
        "flowId",
        "evidenceId",
        "partial"
      ]
    },
    "CommandTarget": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "scope": {
              "const": "run"
            },
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "expectedRunVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "expectedSessionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "scope",
            "sessionId",
            "runId",
            "turnId",
            "expectedRunVersion",
            "expectedSessionVersion"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "scope": {
              "const": "session"
            },
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "expectedSessionVersion": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "scope",
            "sessionId",
            "expectedSessionVersion"
          ]
        }
      ]
    },
    "SessionEvent": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "session-state"
            },
            "session": {
              "$ref": "#/$defs/SessionRecord"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "session"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "message"
            },
            "message": {
              "$ref": "#/$defs/SessionMessage"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "message"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "turn-admitted"
            },
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnOrdinal": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "snapshot": {
              "$ref": "#/$defs/ConfigSnapshot"
            },
            "association": {
              "$ref": "#/$defs/FlowAssociation"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "runId",
            "turnId",
            "turnOrdinal",
            "snapshot",
            "association"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "queue-changed"
            },
            "queueVersion": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "item": {
              "$ref": "#/$defs/QueueItem"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "queueVersion",
            "item"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "command-outcome"
            },
            "outcome": {
              "$ref": "#/$defs/CommandOutcome"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "outcome"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "config-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/ConfigReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "controller-changed"
            },
            "receipt": {
              "$ref": "#/$defs/ControllerReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "operation-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/SessionOperationReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "selection-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/SelectionReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        }
      ]
    },
    "SessionEventPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionEvent"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "retainedFromCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "gap": {
          "type": "boolean"
        }
      },
      "required": [
        "events",
        "cursor",
        "hasMore",
        "retainedFromCursor",
        "gap"
      ]
    },
    "SessionOperationReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "kind": {
          "enum": [
            "create-session",
            "resume-session",
            "fork-session",
            "close-session",
            "edit-queue",
            "remove-queue",
            "reauthorize-queue"
          ]
        },
        "status": {
          "enum": [
            "pending",
            "applied",
            "rejected",
            "recovery-required"
          ]
        },
        "observedSessionVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "session": {
          "anyOf": [
            {
              "$ref": "#/$defs/SessionRecord"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "none",
            "stale-version",
            "busy",
            "policy-changed",
            "workspace-conflict",
            "recovery-required",
            "forbidden"
          ]
        }
      },
      "required": [
        "receiptId",
        "operationId",
        "sessionId",
        "kind",
        "status",
        "observedSessionVersion",
        "session",
        "reason"
      ]
    },
    "CommandConfirmationRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "confirmationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "proposedConfigDigest": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "actorId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "summary": {
          "type": "string",
          "maxLength": 2000
        },
        "costEffect": {
          "type": "string",
          "maxLength": 1000
        },
        "privacyEffect": {
          "type": "string",
          "maxLength": 1000
        }
      },
      "required": [
        "confirmationId",
        "sessionId",
        "operationId",
        "operationDigest",
        "policyDigest",
        "expectedConfigVersion",
        "proposedConfigDigest",
        "controller",
        "actorId",
        "expiresAt",
        "summary",
        "costEffect",
        "privacyEffect"
      ]
    },
    "SelectionReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "selectionReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "configVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "candidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reason": {
          "enum": [
            "baseline",
            "classified",
            "classifier-fallback",
            "provider-fallback"
          ]
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "confirmedOperationDigest": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "observedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "selectionReceiptId",
        "sessionId",
        "runId",
        "turnId",
        "configVersion",
        "candidateId",
        "reason",
        "policyDigest",
        "confirmedOperationDigest",
        "observedAt"
      ]
    },
    "SessionCapabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "literalText": {
          "const": true
        },
        "attachments": {
          "const": false
        },
        "attachmentReason": {
          "const": "typed-artifact-contract-required"
        },
        "commandCatalogue": {
          "const": true
        },
        "modelRouting": {
          "const": true
        }
      },
      "required": [
        "literalText",
        "attachments",
        "attachmentReason",
        "commandCatalogue",
        "modelRouting"
      ]
    },
    "QueueReauthorize": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "originalOperationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "originalOperationId",
        "expectedConfigVersion",
        "association",
        "queueItemId"
      ]
    },
    "CapabilityPage": {
      "oneOf": [
        {
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
            "agentProfileId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "projectionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "inventoryVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "policyDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "capabilityDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "catalogueVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "catalogueDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "cursor": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "nextCursor": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "kind": {
              "const": "catalogue"
            },
            "totalEntries": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1000
            },
            "entries": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/CommandCatalogueEntry"
              },
              "maxItems": 16
            }
          },
          "required": [
            "projectId",
            "checkoutId",
            "agentProfileId",
            "projectionVersion",
            "inventoryVersion",
            "policyDigest",
            "capabilityDigest",
            "catalogueVersion",
            "catalogueDigest",
            "cursor",
            "nextCursor",
            "kind",
            "totalEntries",
            "entries"
          ]
        },
        {
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
            "agentProfileId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "projectionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "inventoryVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "policyDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "capabilityDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "catalogueVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "catalogueDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "cursor": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "nextCursor": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "kind": {
              "const": "routing"
            },
            "totalEntries": {
              "type": "integer",
              "minimum": 0,
              "maximum": 128
            },
            "entries": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/RoutingCandidate"
              },
              "maxItems": 16
            },
            "profileIds": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "maxItems": 128
            }
          },
          "required": [
            "projectId",
            "checkoutId",
            "agentProfileId",
            "projectionVersion",
            "inventoryVersion",
            "policyDigest",
            "capabilityDigest",
            "catalogueVersion",
            "catalogueDigest",
            "cursor",
            "nextCursor",
            "kind",
            "totalEntries",
            "entries",
            "profileIds"
          ]
        }
      ]
    }
  }
}
```

## control-api.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://keryx.local/schemas/hub-remote-sessions/control-api.v2.json",
  "title": "Hub persistent session control API v2 definitions",
  "description": "Validate a named $defs entry for its endpoint; root schema is not an endpoint validator. Encoded byte quotas and authorization are additionally enforced. Package Version: 0.2.0. Selected catalogue schema validation is mandatory in addition to BoundedJson; no executable routes or external schema references.",
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
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        }
      },
      "required": [
        "sessionId",
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline",
        "association",
        "messageId",
        "text"
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
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedRunVersion",
        "reason",
        "expectedSessionVersion",
        "controller"
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
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedRunVersion",
        "actionFingerprint",
        "policyDigest",
        "decision",
        "expectedSessionVersion",
        "controller"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "workspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "expectedRunVersion",
        "gitBaseSha",
        "outcome",
        "partial",
        "changes",
        "checks",
        "sessionId",
        "turnId",
        "association",
        "workspaceBaseline"
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
          "const": 2
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
        },
        "allowAdHocSessions": {
          "type": "boolean"
        },
        "allowedCandidateIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "maxItems": 128,
          "uniqueItems": true
        },
        "profiles": {
          "type": "array",
          "maxItems": 128,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "profileId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "allowAdHocTurns": {
                "type": "boolean"
              },
              "consentVersion": {
                "type": "integer",
                "minimum": 1
              },
              "allowedCandidateIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
                },
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "profileId",
              "allowAdHocTurns",
              "consentVersion",
              "allowedCandidateIds"
            ]
          }
        }
      },
      "required": [
        "version",
        "hubId",
        "enabled",
        "maxConcurrentRuns",
        "checkouts",
        "allowAdHocSessions",
        "allowedCandidateIds",
        "profiles"
      ]
    },
    "BrowserInvalidation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 2
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
            "context",
            "session",
            "history",
            "queue",
            "command-catalogue",
            "config",
            "controller"
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
        },
        "target": {
          "$ref": "#/$defs/CommandTarget"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerBinding"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "commandDigest",
        "policyDigest",
        "target",
        "controller"
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
        },
        "target": {
          "$ref": "#/$defs/CommandTarget"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerBinding"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "grantId",
        "commandId",
        "commandDigest",
        "authorizedBy",
        "authorizedAt",
        "expiresAt",
        "policyDigest",
        "target",
        "controller"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "observedAt",
        "sessionId",
        "turnId"
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
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "observation",
        "sessionId",
        "turnId"
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
              "sessionId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "turnId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "association": {
                "$ref": "#/$defs/FlowAssociation"
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
              "sessionId",
              "turnId",
              "association"
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
        },
        "sessions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionRecord"
          },
          "maxItems": 100
        }
      },
      "required": [
        "runs",
        "cursor",
        "hasMore",
        "hubSequence",
        "sessions"
      ]
    },
    "FlowAssociation": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "flow"
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
            "specDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "criteriaDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "mode",
            "flowId",
            "expectedFlowVersion",
            "specDigest",
            "criteriaDigest"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "mode": {
              "const": "ad-hoc"
            },
            "profileConsentVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "mode",
            "profileConsentVersion"
          ]
        }
      ]
    },
    "ControllerBinding": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedControllerVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "controllerLeaseId",
        "expectedControllerVersion"
      ]
    },
    "ControllerLease": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "actorId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "actorKind": {
          "const": "human-operator"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "state": {
          "enum": [
            "held",
            "released",
            "expired"
          ]
        }
      },
      "required": [
        "controllerLeaseId",
        "sessionId",
        "version",
        "actorId",
        "actorKind",
        "expiresAt",
        "state"
      ]
    },
    "SessionMutationBase": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller"
      ]
    },
    "SessionCreate": {
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
        "expectedInventoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHeadSha": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{40,64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "title": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "machineId",
        "checkoutId",
        "agentProfileId",
        "expectedInventoryVersion",
        "expectedHeadSha",
        "capabilityDigest",
        "policyDigest",
        "title"
      ]
    },
    "SessionOpen": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "expectedSessionVersion"
      ]
    },
    "SessionResume": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline"
      ]
    },
    "SessionFork": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "throughHistoryCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "targetCheckoutId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
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
        "title": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "throughHistoryCursor",
        "expectedHistoryVersion",
        "targetCheckoutId",
        "expectedInventoryVersion",
        "expectedHeadSha",
        "title"
      ]
    },
    "SessionClose": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "mode": {
          "enum": [
            "when-idle",
            "cancel-and-close"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "mode"
      ]
    },
    "ControllerClaim": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedControllerVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "requestedLeaseSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 60
        },
        "mode": {
          "enum": [
            "claim",
            "renew",
            "takeover"
          ]
        },
        "previousReleaseReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "controllerLeaseId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "expectedControllerVersion",
        "requestedLeaseSeconds",
        "mode"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "mode": {
                "const": "takeover"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "required": [
              "previousReleaseReceiptId"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "mode": {
                "const": "renew"
              }
            },
            "required": [
              "mode"
            ]
          },
          "then": {
            "required": [
              "controllerLeaseId"
            ]
          }
        }
      ]
    },
    "ControllerRelease": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller"
      ]
    },
    "ControllerReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "lease": {
          "$ref": "#/$defs/ControllerLease"
        }
      },
      "required": [
        "receiptId",
        "sessionVersion",
        "lease"
      ]
    },
    "RoutingConfig": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "profileId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "candidateIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "minItems": 1,
          "maxItems": 32,
          "uniqueItems": true
        },
        "fallbackCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "enabled",
        "profileId",
        "candidateIds",
        "fallbackCandidateId"
      ]
    },
    "SessionConfig": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "configVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "baselineCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEffort": {
          "enum": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        },
        "routing": {
          "$ref": "#/$defs/RoutingConfig"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "configVersion",
        "baselineCandidateId",
        "reasoningEffort",
        "routing",
        "policyDigest",
        "capabilityDigest"
      ]
    },
    "ConfigSnapshot": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "config": {
          "$ref": "#/$defs/SessionConfig"
        },
        "configDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "effectiveCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "routingDecision": {
          "enum": [
            "baseline",
            "classified",
            "classifier-fallback"
          ]
        },
        "fallbackReason": {
          "enum": [
            "none",
            "classifier-failed",
            "candidate-unavailable",
            "policy-denied"
          ]
        },
        "selectionReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "config",
        "configDigest",
        "effectiveCandidateId",
        "routingDecision",
        "fallbackReason",
        "selectionReceiptId"
      ]
    },
    "RoutingCandidate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "candidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "providerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "modelId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEfforts": {
          "type": "array",
          "items": {
            "enum": [
              "none",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max"
            ]
          },
          "maxItems": 8
        },
        "available": {
          "type": "boolean"
        },
        "reason": {
          "enum": [
            "none",
            "not-connected",
            "local-policy",
            "budget",
            "consent-required"
          ]
        },
        "privacyClass": {
          "enum": [
            "local",
            "approved-egress"
          ]
        },
        "costClass": {
          "enum": [
            "local",
            "metered"
          ]
        }
      },
      "required": [
        "candidateId",
        "providerId",
        "modelId",
        "reasoningEfforts",
        "available",
        "reason",
        "privacyClass",
        "costClass"
      ]
    },
    "RoutingAvailability": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "candidates": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/RoutingCandidate"
          },
          "maxItems": 128
        },
        "profileIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
          },
          "maxItems": 128
        }
      },
      "required": [
        "version",
        "policyDigest",
        "capabilityDigest",
        "candidates",
        "profileIds"
      ]
    },
    "ConfigChange": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "baselineCandidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reasoningEffort": {
          "enum": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        },
        "routing": {
          "$ref": "#/$defs/RoutingConfig"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "baselineCandidateId",
        "reasoningEffort",
        "routing",
        "busyPolicy"
      ]
    },
    "ConfigReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "status": {
          "enum": [
            "queued",
            "applied",
            "rejected",
            "confirmation-required"
          ]
        },
        "configVersion": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "effectiveFromTurnOrdinal": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "none",
            "busy",
            "stale-version",
            "policy-changed",
            "confirmation-required",
            "candidate-unavailable"
          ]
        },
        "confirmation": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommandConfirmationRequest"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "receiptId",
        "operationId",
        "sessionId",
        "sessionVersion",
        "status",
        "configVersion",
        "effectiveFromTurnOrdinal",
        "reason",
        "confirmation"
      ]
    },
    "SessionRecord": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
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
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "historyVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "state": {
          "enum": [
            "opening",
            "idle",
            "busy",
            "paused",
            "closed",
            "recovery-required"
          ]
        },
        "title": {
          "type": "string",
          "maxLength": 200
        },
        "config": {
          "$ref": "#/$defs/SessionConfig"
        },
        "controller": {
          "anyOf": [
            {
              "$ref": "#/$defs/ControllerLease"
            },
            {
              "type": "null"
            }
          ]
        },
        "activeRunId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "activeTurnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "nextTurnOrdinal": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "historyCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sessionEventCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "queueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "workspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "forkedFromSessionId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "capabilities": {
          "$ref": "#/$defs/SessionCapabilities"
        }
      },
      "required": [
        "sessionId",
        "projectId",
        "machineId",
        "checkoutId",
        "agentProfileId",
        "version",
        "historyVersion",
        "state",
        "title",
        "config",
        "controller",
        "activeRunId",
        "activeTurnId",
        "nextTurnOrdinal",
        "historyCursor",
        "sessionEventCursor",
        "queueVersion",
        "workspaceBaseline",
        "forkedFromSessionId",
        "capabilities"
      ]
    },
    "SessionPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionRecord"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        }
      },
      "required": [
        "sessions",
        "cursor",
        "hasMore"
      ]
    },
    "SessionMessage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "historyCursor": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "role": {
          "enum": [
            "human",
            "assistant",
            "tool-summary",
            "system-receipt"
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "messageId",
        "sessionId",
        "historyCursor",
        "role",
        "text",
        "createdAt",
        "turnId",
        "runId"
      ]
    },
    "HistoryPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "messages": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionMessage"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "historyVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "retainedFromCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "gap": {
          "type": "boolean"
        }
      },
      "required": [
        "messages",
        "cursor",
        "hasMore",
        "historyVersion",
        "retainedFromCursor",
        "gap"
      ]
    },
    "MessageSubmit": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "interpretation": {
          "const": "literal-message"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "enqueue"
          ]
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "text",
        "interpretation",
        "association",
        "busyPolicy"
      ]
    },
    "TurnReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "queueItemId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "status": {
          "enum": [
            "queued",
            "admitted",
            "rejected"
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnOrdinal": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "operationId",
        "messageId",
        "sessionId",
        "sessionVersion",
        "queueItemId",
        "status",
        "runId",
        "turnId",
        "turnOrdinal"
      ]
    },
    "QueueItem": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "kind": {
          "enum": [
            "message",
            "command",
            "config"
          ]
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "state": {
          "enum": [
            "queued",
            "admitted",
            "applied",
            "rejected",
            "removed",
            "suspended"
          ]
        },
        "position": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "text": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 32768
            },
            {
              "type": "null"
            }
          ]
        },
        "commandName": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "replacesOperationId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "queueItemId",
        "version",
        "kind",
        "operationId",
        "state",
        "position",
        "text",
        "commandName",
        "expectedConfigVersion",
        "replacesOperationId"
      ]
    },
    "QueuePage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/QueueItem"
          },
          "maxItems": 100
        },
        "queueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        }
      },
      "required": [
        "items",
        "queueVersion",
        "cursor",
        "hasMore"
      ]
    },
    "QueueEdit": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "text",
        "queueItemId"
      ]
    },
    "QueueRemove": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "queueItemId"
      ]
    },
    "BoundedJson": {
      "oneOf": [
        {
          "type": "null"
        },
        {
          "type": "boolean"
        },
        {
          "type": "number"
        },
        {
          "type": "string",
          "maxLength": 32768
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/BoundedJson"
          },
          "maxItems": 128
        },
        {
          "type": "object",
          "maxProperties": 64,
          "propertyNames": {
            "type": "string",
            "maxLength": 100
          },
          "additionalProperties": {
            "$ref": "#/$defs/BoundedJson"
          }
        }
      ]
    },
    "ArgumentSchema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "string"
            },
            "maxLength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 32768
            },
            "enum": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 32768
              },
              "minItems": 1,
              "maxItems": 128,
              "uniqueItems": true
            }
          },
          "required": [
            "type",
            "maxLength"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "enum": [
                "integer",
                "number"
              ]
            },
            "minimum": {
              "type": "number"
            },
            "maximum": {
              "type": "number"
            }
          },
          "required": [
            "type",
            "minimum",
            "maximum"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "enum": [
                "boolean",
                "null"
              ]
            }
          },
          "required": [
            "type"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "array"
            },
            "items": {
              "$ref": "#/$defs/ArgumentSchema"
            },
            "maxItems": {
              "type": "integer",
              "minimum": 0,
              "maximum": 128
            }
          },
          "required": [
            "type",
            "items",
            "maxItems"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": {
              "const": "object"
            },
            "additionalProperties": {
              "const": false
            },
            "properties": {
              "type": "object",
              "maxProperties": 64,
              "propertyNames": {
                "type": "string",
                "maxLength": 100
              },
              "additionalProperties": {
                "$ref": "#/$defs/ArgumentSchema"
              }
            },
            "required": {
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 100
              },
              "maxItems": 64,
              "uniqueItems": true
            }
          },
          "required": [
            "type",
            "additionalProperties",
            "properties",
            "required"
          ]
        }
      ]
    },
    "CommandCatalogueEntry": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "summary": {
          "type": "string",
          "maxLength": 1000
        },
        "handlerId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "inputSchema": {
          "$ref": "#/$defs/ArgumentSchema"
        },
        "resultSchema": {
          "$ref": "#/$defs/ArgumentSchema"
        },
        "mutationClass": {
          "enum": [
            "read",
            "session",
            "workspace",
            "sensitive-setup"
          ]
        },
        "states": {
          "type": "array",
          "items": {
            "enum": [
              "idle",
              "busy",
              "paused",
              "closed"
            ]
          },
          "maxItems": 3
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle",
            "read-only"
          ]
        },
        "confirmation": {
          "enum": [
            "none",
            "human",
            "local-only"
          ]
        },
        "availability": {
          "enum": [
            "available",
            "setup-required",
            "policy-denied",
            "implementation-gap"
          ]
        },
        "reason": {
          "type": "string",
          "maxLength": 1000
        }
      },
      "required": [
        "commandName",
        "summary",
        "handlerId",
        "inputSchema",
        "resultSchema",
        "mutationClass",
        "states",
        "busyPolicy",
        "confirmation",
        "availability",
        "reason"
      ]
    },
    "CommandCatalogue": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "catalogueVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "catalogueDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "capabilityDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "entries": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/CommandCatalogueEntry"
          },
          "maxItems": 1000
        }
      },
      "required": [
        "catalogueVersion",
        "catalogueDigest",
        "capabilityDigest",
        "entries"
      ]
    },
    "CommandInvoke": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "catalogueDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "arguments": {
          "$ref": "#/$defs/BoundedJson"
        },
        "busyPolicy": {
          "enum": [
            "reject",
            "queue-at-idle"
          ]
        },
        "confirmationReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "catalogueDigest",
        "commandName",
        "arguments",
        "busyPolicy"
      ]
    },
    "CommandOutcome": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "commandName": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "status": {
          "enum": [
            "queued",
            "applied",
            "rejected",
            "confirmation-required",
            "recovery-required"
          ]
        },
        "sessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "result": {
          "$ref": "#/$defs/BoundedJson"
        },
        "confirmationId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "errorCode": {
          "anyOf": [
            {
              "enum": [
                "invalid-arguments",
                "stale-catalogue",
                "busy",
                "forbidden",
                "confirmation-expired",
                "policy-changed",
                "unknown-command",
                "implementation-gap"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "confirmation": {
          "anyOf": [
            {
              "$ref": "#/$defs/CommandConfirmationRequest"
            },
            {
              "type": "null"
            }
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "turnId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "operationId",
        "sessionId",
        "commandName",
        "status",
        "sessionVersion",
        "result",
        "confirmationId",
        "errorCode",
        "confirmation",
        "runId",
        "turnId"
      ]
    },
    "CommandConfirmation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "confirmationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationDigest": {
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
        "expectedSessionVersion",
        "controller",
        "confirmationId",
        "operationDigest",
        "policyDigest",
        "decision"
      ]
    },
    "StartTurnRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedHistoryVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "expectedWorkspaceBaseline": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "messageId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "text": {
          "type": "string",
          "maxLength": 32768
        }
      },
      "required": [
        "sessionId",
        "expectedSessionVersion",
        "controller",
        "expectedConfigVersion",
        "expectedHistoryVersion",
        "expectedWorkspaceBaseline",
        "association",
        "messageId",
        "text"
      ]
    },
    "ResultReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "revisionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "checksKind": {
          "enum": [
            "FlowEvidence",
            "RunChecks"
          ]
        },
        "flowId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "evidenceId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "partial": {
          "type": "boolean"
        }
      },
      "required": [
        "receiptId",
        "runId",
        "turnId",
        "sessionId",
        "revisionId",
        "checksKind",
        "flowId",
        "evidenceId",
        "partial"
      ]
    },
    "CommandTarget": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "scope": {
              "const": "run"
            },
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "expectedRunVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "expectedSessionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "scope",
            "sessionId",
            "runId",
            "turnId",
            "expectedRunVersion",
            "expectedSessionVersion"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "scope": {
              "const": "session"
            },
            "sessionId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "expectedSessionVersion": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "scope",
            "sessionId",
            "expectedSessionVersion"
          ]
        }
      ]
    },
    "SessionEvent": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "session-state"
            },
            "session": {
              "$ref": "#/$defs/SessionRecord"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "session"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "message"
            },
            "message": {
              "$ref": "#/$defs/SessionMessage"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "message"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "turn-admitted"
            },
            "runId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "turnOrdinal": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "snapshot": {
              "$ref": "#/$defs/ConfigSnapshot"
            },
            "association": {
              "$ref": "#/$defs/FlowAssociation"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "runId",
            "turnId",
            "turnOrdinal",
            "snapshot",
            "association"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "queue-changed"
            },
            "queueVersion": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "item": {
              "$ref": "#/$defs/QueueItem"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "queueVersion",
            "item"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "command-outcome"
            },
            "outcome": {
              "$ref": "#/$defs/CommandOutcome"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "outcome"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "config-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/ConfigReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "controller-changed"
            },
            "receipt": {
              "$ref": "#/$defs/ControllerReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "operation-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/SessionOperationReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sessionId": {
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
            "sessionEventSeq": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "observedAt": {
              "type": "string",
              "format": "date-time"
            },
            "kind": {
              "const": "selection-receipt"
            },
            "receipt": {
              "$ref": "#/$defs/SelectionReceipt"
            }
          },
          "required": [
            "sessionId",
            "projectId",
            "checkoutId",
            "sessionEventSeq",
            "observedAt",
            "kind",
            "receipt"
          ]
        }
      ]
    },
    "SessionEventPage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "events": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/SessionEvent"
          },
          "maxItems": 100
        },
        "cursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "retainedFromCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "gap": {
          "type": "boolean"
        }
      },
      "required": [
        "events",
        "cursor",
        "hasMore",
        "retainedFromCursor",
        "gap"
      ]
    },
    "SessionOperationReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "receiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "kind": {
          "enum": [
            "create-session",
            "resume-session",
            "fork-session",
            "close-session",
            "edit-queue",
            "remove-queue",
            "reauthorize-queue"
          ]
        },
        "status": {
          "enum": [
            "pending",
            "applied",
            "rejected",
            "recovery-required"
          ]
        },
        "observedSessionVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "session": {
          "anyOf": [
            {
              "$ref": "#/$defs/SessionRecord"
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "enum": [
            "none",
            "stale-version",
            "busy",
            "policy-changed",
            "workspace-conflict",
            "recovery-required",
            "forbidden"
          ]
        }
      },
      "required": [
        "receiptId",
        "operationId",
        "sessionId",
        "kind",
        "status",
        "observedSessionVersion",
        "session",
        "reason"
      ]
    },
    "CommandConfirmationRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "confirmationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "operationDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "proposedConfigDigest": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "actorId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "summary": {
          "type": "string",
          "maxLength": 2000
        },
        "costEffect": {
          "type": "string",
          "maxLength": 1000
        },
        "privacyEffect": {
          "type": "string",
          "maxLength": 1000
        }
      },
      "required": [
        "confirmationId",
        "sessionId",
        "operationId",
        "operationDigest",
        "policyDigest",
        "expectedConfigVersion",
        "proposedConfigDigest",
        "controller",
        "actorId",
        "expiresAt",
        "summary",
        "costEffect",
        "privacyEffect"
      ]
    },
    "SelectionReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "selectionReceiptId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "sessionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "turnId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "configVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "candidateId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "reason": {
          "enum": [
            "baseline",
            "classified",
            "classifier-fallback",
            "provider-fallback"
          ]
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "confirmedOperationDigest": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "observedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "selectionReceiptId",
        "sessionId",
        "runId",
        "turnId",
        "configVersion",
        "candidateId",
        "reason",
        "policyDigest",
        "confirmedOperationDigest",
        "observedAt"
      ]
    },
    "SessionCapabilities": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "literalText": {
          "const": true
        },
        "attachments": {
          "const": false
        },
        "attachmentReason": {
          "const": "typed-artifact-contract-required"
        },
        "commandCatalogue": {
          "const": true
        },
        "modelRouting": {
          "const": true
        }
      },
      "required": [
        "literalText",
        "attachments",
        "attachmentReason",
        "commandCatalogue",
        "modelRouting"
      ]
    },
    "QueueReauthorize": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "expectedSessionVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "controller": {
          "$ref": "#/$defs/ControllerBinding"
        },
        "expectedQueueVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedItemVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "originalOperationId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        },
        "expectedConfigVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "association": {
          "$ref": "#/$defs/FlowAssociation"
        },
        "queueItemId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
        }
      },
      "required": [
        "expectedSessionVersion",
        "controller",
        "expectedQueueVersion",
        "expectedItemVersion",
        "originalOperationId",
        "expectedConfigVersion",
        "association",
        "queueItemId"
      ]
    },
    "CapabilityPage": {
      "oneOf": [
        {
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
            "agentProfileId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "projectionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "inventoryVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "policyDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "capabilityDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "catalogueVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "catalogueDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "cursor": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "nextCursor": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "kind": {
              "const": "catalogue"
            },
            "totalEntries": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1000
            },
            "entries": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/CommandCatalogueEntry"
              },
              "maxItems": 16
            }
          },
          "required": [
            "projectId",
            "checkoutId",
            "agentProfileId",
            "projectionVersion",
            "inventoryVersion",
            "policyDigest",
            "capabilityDigest",
            "catalogueVersion",
            "catalogueDigest",
            "cursor",
            "nextCursor",
            "kind",
            "totalEntries",
            "entries"
          ]
        },
        {
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
            "agentProfileId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
            },
            "projectionVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "inventoryVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "policyDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "capabilityDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "catalogueVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "catalogueDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "cursor": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "nextCursor": {
              "anyOf": [
                {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "type": "null"
                }
              ]
            },
            "kind": {
              "const": "routing"
            },
            "totalEntries": {
              "type": "integer",
              "minimum": 0,
              "maximum": 128
            },
            "entries": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/RoutingCandidate"
              },
              "maxItems": 16
            },
            "profileIds": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
              },
              "maxItems": 128
            }
          },
          "required": [
            "projectId",
            "checkoutId",
            "agentProfileId",
            "projectionVersion",
            "inventoryVersion",
            "policyDigest",
            "capabilityDigest",
            "catalogueVersion",
            "catalogueDigest",
            "cursor",
            "nextCursor",
            "kind",
            "totalEntries",
            "entries",
            "profileIds"
          ]
        }
      ]
    }
  }
}
```
