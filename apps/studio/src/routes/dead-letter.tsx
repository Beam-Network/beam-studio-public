import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route: any = createFileRoute("/dead-letter")({
  component: () => (
    <Navigate replace search={{ view: "dead-letter" } as never} to="/runs" />
  ),
});
