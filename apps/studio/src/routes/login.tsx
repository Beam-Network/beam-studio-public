import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route: any = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  useEffect(() => {
    window.location.replace(`/auth${window.location.search}`);
  }, []);

  return null;
}
