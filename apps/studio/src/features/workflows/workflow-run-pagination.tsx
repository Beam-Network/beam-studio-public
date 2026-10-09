import { Button } from "@/components/ui/button";

export function WorkflowRunPagination({
  page,
  previous,
  next,
  pending,
}: {
  page: number;
  previous?: () => void;
  next?: () => void;
  pending: boolean;
}) {
  if (!previous && !next) return null;
  return (
    <nav
      aria-label="Run history pages"
      className="flex items-center justify-end gap-3"
    >
      <Button
        variant="outline"
        size="sm"
        disabled={pending || !previous}
        onClick={previous}
      >
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">Page {page}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending || !next}
        onClick={next}
      >
        Next
      </Button>
    </nav>
  );
}
