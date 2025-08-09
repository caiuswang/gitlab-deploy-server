import { createApp } from "./app";
import { SERVER_PORT } from "./config";

const app = createApp();
app.listen(Number(SERVER_PORT), "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`ts-deploy-server listening on :${SERVER_PORT}`);
});