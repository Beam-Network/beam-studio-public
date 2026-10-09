import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route: any = createFileRoute("/queue")({
  component: () => (
    <Navigate replace search={{ view: "queue" } as never} to="/runs" />
  ),
});
