import { MCP_ADMIN_SCOPES } from "@beam-studio/shared";
import { useState } from "react";
import { ResourceAppPage } from "@/components/data-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function McpTokensPage() {
  const [token, setToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const clearToken = () => {
    setToken(null);
    setCopyStatus("");
  };
  return (
    <>
      <ResourceAppPage
        collectionKey="tokens"
        create={{
          title: "Create MCP token",
          endpoint: "/studio/mcp/tokens",
          fields: [
            { name: "name", label: "Name" },
            { name: "expiresAt", label: "Expires at" },
            {
              name: "scopes",
              label: "Scopes JSON",
              type: "json",
              // Spelled out rather than a shorthand: the API rejects any name it
              // does not recognise, and an admin grant should be visible as one.
              defaultValue: [...MCP_ADMIN_SCOPES],
            },
          ],
          onCreated: (result) => {
            setToken(typeof result.token === "string" ? result.token : null);
            setCopyStatus("");
          },
        }}
        endpoint="/studio/mcp"
        hidePageHeader
        title="MCP tokens"
        actions={[
          {
            label: "Revoke",
            method: "POST",
            path: (row) => `/studio/mcp/tokens/${row.id}/revoke`,
          },
          {
            label: "Delete",
            method: "DELETE",
            path: (row) => `/studio/mcp/tokens/${row.id}`,
            confirm: "Delete this MCP token?",
          },
        ]}
      />
      <Dialog
        open={token !== null}
        onOpenChange={(open) => {
          if (!open) clearToken();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your MCP token</DialogTitle>
            <DialogDescription>
              This token is shown only once. Store it securely before closing
              this dialog.
            </DialogDescription>
          </DialogHeader>
          <textarea
            aria-label="MCP token"
            readOnly
            value={token ?? ""}
            className="w-full rounded-control border bg-background p-3 font-mono text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token ?? "");
                  setCopyStatus("Copied");
                } catch {
                  setCopyStatus(
                    "Copy failed. Select the token or download it.",
                  );
                }
              }}
            >
              Copy token
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([`${token}\n`], { type: "text/plain" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "beam-studio-mcp-token.txt";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download token
            </Button>
            <Button variant="outline" onClick={clearToken}>
              Done
            </Button>
          </div>
          {copyStatus ? (
            <p role="status" className="text-sm">
              {copyStatus}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
