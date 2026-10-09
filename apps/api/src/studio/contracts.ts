export function studioContracts() {
  return {
    version: 5,
    smokeRoutes: [
      "/dashboard",
      "/credentials",
      "/transfers",
      "/runs",
      "/schedules",
      "/workflows",
      "/registry",
      "/orchestration",
      "/agents",
      "/mcp",
      "/settings",
    ],
    api: {
      session: {
        method: "GET",
        path: "/studio/session",
        responseKeys: ["session"],
      },
      credentials: {
        list: {
          method: "GET",
          path: "/studio/credentials",
          responseKeys: ["credentials"],
        },
        create: {
          method: "POST",
          path: "/studio/credentials",
          requestKeys: ["name", "kind", "payload"],
          responseKeys: ["id", "created"],
        },
      },
      actions: {
        list: {
          method: "GET",
          path: "/studio/workflow-actions",
          responseKeys: ["actions"],
        },
      },
      workflows: {
        layout: {
          method: "PATCH",
          path: "/studio/workflows/:id/layout",
          requestKeys: ["revision", "positions"],
          responseKeys: ["revision"],
        },
        readLayout: {
          method: "GET",
          path: "/studio/workflows/:id/layout",
          responseKeys: ["revision", "positions"],
        },
        move: {
          method: "PATCH",
          path: "/studio/workflows/:id/sidebar-parent",
          requestKeys: ["parentId"],
          responseKeys: ["id", "sidebarParentId"],
        },
        list: {
          method: "GET",
          path: "/studio/workflows",
          responseKeys: ["workflows"],
        },
        create: {
          method: "POST",
          path: "/studio/workflows",
          requestKeys: ["name", "description"],
          responseKeys: ["id", "created"],
        },
        duplicate: {
          method: "POST",
          path: "/studio/workflows/:id/duplicate",
          responseKeys: ["id", "duplicated"],
        },
        graph: {
          method: "PATCH",
          path: "/studio/workflows/:id/graph",
          requestKeys: [
            "graphVersion",
            "controls",
            "distribution",
            "triggers",
            "triggerEdges",
            "decisions",
            "decisionEdges",
            "steps",
            "edges",
          ],
        },
      },
      runs: {
        list: {
          method: "GET",
          path: "/studio/workflow-runs",
          queryKeys: [
            "workflowTemplateId",
            "status",
            "search",
            "view",
            "cursor",
            "limit",
          ],
          responseKeys: ["runs", "totalCount", "nextCursor"],
        },
        detail: {
          method: "GET",
          path: "/studio/workflow-runs/:id",
        },
        evidence: {
          method: "GET",
          path: "/studio/workflow-runs/:id/evidence",
          responseKeys: ["steps"],
        },
        artifactContent: {
          method: "GET",
          path: "/studio/workflow-runs/:id/artifacts/:artifactId/content",
        },
        cancel: {
          method: "POST",
          path: "/studio/workflow-runs/:id/cancel",
          responseKeys: ["cancelled"],
        },
        retry: {
          method: "POST",
          path: "/studio/workflow-runs/:id/retry",
          responseKeys: ["runId"],
        },
        regionInstances: {
          method: "GET",
          path: "/studio/workflow-runs/:id/regions/:controlId/instances",
          responseKeys: ["region", "instances", "offset", "limit", "total"],
        },
        cancelRegion: {
          method: "POST",
          path: "/studio/workflow-runs/:id/regions/:controlId/cancel",
          responseKeys: ["region"],
        },
        retryRegion: {
          method: "POST",
          path: "/studio/workflow-runs/:id/regions/:controlId/retry",
          responseKeys: ["region"],
        },
      },
      schedules: {
        list: {
          method: "GET",
          path: "/studio/schedules",
          responseKeys: ["schedules"],
        },
        create: {
          method: "POST",
          path: "/studio/schedules",
          requestKeys: ["transferTemplateId", "frequency"],
          responseKeys: ["id", "created"],
        },
      },
      beamEnvironments: {
        settings: {
          method: "GET",
          path: "/studio/beam-environment-settings",
          responseKeys: [
            "devSettingsEnabled",
            "defaultTemplateKey",
            "templates",
          ],
        },
        updateDefault: {
          method: "PATCH",
          path: "/studio/beam-environment-settings",
          requestKeys: ["defaultTemplateKey"],
          responseKeys: [
            "devSettingsEnabled",
            "defaultTemplateKey",
            "templates",
          ],
        },
        upsertTemplate: {
          method: "PUT",
          path: "/studio/beam-environment-templates/:key",
          requestKeys: [
            "name",
            "baseUrl",
            "coordinatorUrl",
            "natsUrl",
            "authUrl",
            "apiUrl",
            "registryUrl",
          ],
          responseKeys: [
            "devSettingsEnabled",
            "defaultTemplateKey",
            "templates",
          ],
        },
        deleteTemplate: {
          method: "DELETE",
          path: "/studio/beam-environment-templates/:key",
          responseKeys: [
            "devSettingsEnabled",
            "defaultTemplateKey",
            "templates",
          ],
        },
      },
      agents: {
        list: {
          method: "GET",
          path: "/studio/agents",
          responseKeys: ["agents"],
        },
        detail: {
          method: "GET",
          path: "/studio/agents/:id",
          responseKeys: ["agent", "commands", "events"],
        },
        enrollment: {
          method: "POST",
          path: "/studio/agents/enrollments",
          requestKeys: ["machineName"],
          responseKeys: ["enrollmentId", "code", "expiresAt"],
        },
        command: {
          method: "POST",
          path: "/studio/agents/:id/commands",
          requestKeys: ["operation", "payload", "idempotencyKey"],
          responseKeys: ["command", "dispatched"],
        },
        revoke: {
          method: "POST",
          path: "/studio/agents/:id/revoke",
          responseKeys: ["revoked"],
        },
        delete: {
          method: "DELETE",
          path: "/studio/agents/:id",
          responseKeys: ["deleted"],
        },
      },
      assistant: {
        tools: {
          method: "GET",
          path: "/studio/assistant/tools",
          responseKeys: ["tools"],
        },
        plan: {
          method: "POST",
          path: "/studio/assistant/plan",
          requestKeys: ["prompt", "conversationId", "idempotencyKey"],
          responseKeys: ["plan"],
        },
        validate: {
          method: "POST",
          path: "/studio/assistant/plans/:id/validate",
          requestKeys: ["inputs"],
          responseKeys: ["plan", "errors"],
        },
        confirm: {
          method: "POST",
          path: "/studio/assistant/plans/:id/confirm",
          responseKeys: ["plan"],
        },
        execute: {
          method: "POST",
          path: "/studio/assistant/plans/:id/execute",
          responseKeys: ["plan"],
        },
        get: {
          method: "GET",
          path: "/studio/assistant/plans/:id",
          responseKeys: ["plan"],
        },
        cancel: {
          method: "POST",
          path: "/studio/assistant/plans/:id/cancel",
          responseKeys: ["plan"],
        },
        rollback: {
          method: "POST",
          path: "/studio/assistant/plans/:id/rollback",
          responseKeys: ["plan"],
        },
        oneTimeSecret: {
          method: "POST",
          path: "/studio/assistant/secrets/:id",
          responseKeys: ["secret"],
        },
      },
    },
  };
}
