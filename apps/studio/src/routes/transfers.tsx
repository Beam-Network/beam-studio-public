import { createFileRoute } from "@tanstack/react-router";
import { ResourceAppPage } from "@/components/data-page";

export const Route: any = createFileRoute("/transfers")({
  component: () => (
    <ResourceAppPage
      collectionKey="transfers"
      create={{
        title: "Create transfer",
        endpoint: "/studio/transfers",
        fields: [
          { name: "name", label: "Name" },
          { name: "description", label: "Description" },
          { name: "apiKeyId", label: "API key ID" },
          { name: "beamServerUrl", label: "Beam server URL" },
          {
            name: "enabled",
            label: "Enabled",
            type: "checkbox",
            defaultValue: true,
          },
        ],
        redirectTo: (result) => `/transfers/${result.id}`,
      }}
      detailPath={(row) => `/transfers/${row.id}`}
      endpoint="/studio/transfers"
      title="Transfers"
      actions={[
        {
          label: "Toggle",
          method: "POST",
          path: (row) => `/studio/transfers/${row.id}/toggle`,
        },
        {
          label: "Run",
          method: "POST",
          path: (row) => `/studio/transfers/${row.id}/run`,
        },
        {
          label: "Delete",
          method: "DELETE",
          path: (row) => `/studio/transfers/${row.id}`,
          confirm: "Delete this transfer?",
        },
      ]}
    />
  ),
});
