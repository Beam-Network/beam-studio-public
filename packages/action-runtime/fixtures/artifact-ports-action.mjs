// Shared package source for locked Runner/member artifact-port conformance.
export async function execute(_input, context) {
  const content = await context.artifacts.readInput("source");
  await context.artifacts.publishOutput("result", content, {
    name: "result.txt",
    mediaType: "text/plain",
  });
  return { outputs: {} };
}
