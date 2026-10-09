import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "./new";

// Keep the chat mounted when the first message moves / to /c/:id.
export const Route: any = createFileRoute("/_home")({
  component: HomePage,
});
