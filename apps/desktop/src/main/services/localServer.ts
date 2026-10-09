export async function startLocalServer() {
  return {
    url: "http://127.0.0.1:0",
    stop: async () => {}
  };
}
