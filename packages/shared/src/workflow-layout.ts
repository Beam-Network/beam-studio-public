import { z } from "zod";

export const workflowLayoutPatchSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    positions: z.array(
      z
        .object({
          nodeId: z.string().trim().min(1).max(200),
          x: z
            .number()
            .finite()
            .refine(
              (value) => Number.isFinite(Math.fround(value)),
              "Coordinate exceeds storage precision.",
            ),
          y: z
            .number()
            .finite()
            .refine(
              (value) => Number.isFinite(Math.fround(value)),
              "Coordinate exceeds storage precision.",
            ),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const position of value.positions) {
      if (ids.has(position.nodeId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate layout node.",
        });
      ids.add(position.nodeId);
    }
  });

export type WorkflowLayoutPatch = z.infer<typeof workflowLayoutPatchSchema>;
export type WorkflowLayoutPosition = {
  nodeId: string;
  x: number | null;
  y: number | null;
};
export type WorkflowLayout = {
  revision: number;
  positions: WorkflowLayoutPosition[];
};
