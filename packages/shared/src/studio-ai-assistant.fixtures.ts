import type { AssistantWorkflowPlan } from "./studio-ai-assistant.js";

export const assistantPromptFixtures = {
  generateS3Transfer:
    "Copy the files from an S3 bucket to another bucket with a Beam transfer.",
  explainCredentialError:
    "Why does my workflow say the Beam transfer requires a credential?",
  fixMissingBinding:
    "The upload step has no content input. Suggest the binding to add.",
} as const;

export const assistantWorkflowPlanFixtures = {
  s3Transfer: {
    message:
      "Create a manual workflow that transfers objects between two S3 endpoints.",
    plan: [
      "Add a manual trigger.",
      "Add source and destination object storage endpoints.",
      "Start a Beam transfer between them.",
    ],
    patch: [
      {
        op: "add_trigger",
        ref: "manual_trigger",
        triggerType: "manual",
        name: "Trigger manually",
      },
      {
        op: "add_step",
        ref: "source_endpoint",
        actionPackageName: "@beam/object-storage-endpoint",
        config: {
          bucket: "",
          credentialId: "",
          objectKey: "",
          provider: "s3",
        },
      },
      {
        op: "add_step",
        ref: "beam_transfer",
        actionPackageName: "@beam/transfer",
        config: {},
      },
      {
        op: "connect",
        fromRef: "manual_trigger",
        toRef: "source_endpoint",
      },
      {
        op: "set_binding",
        stepRef: "beam_transfer",
        inputKey: "sourceEndpoints",
        expression: "${steps.source_endpoint.outputs.endpoint}",
      },
    ],
    needsInput: ["Source credential", "Bucket and object key"],
    risks: ["The destination endpoint must be added before running."],
    assumptions: ["The graph is previewed locally before saving."],
  } satisfies AssistantWorkflowPlan,
  invalidUnsupportedOperation: {
    message: "Unsupported direct graph mutation.",
    plan: [],
    patch: [{ op: "delete_node", id: "step_1" }],
    needsInput: [],
    risks: [],
    assumptions: [],
  },
} as const;
