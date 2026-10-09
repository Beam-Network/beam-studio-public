import downloadReadme from "./action-readmes/beam/download/README.md?raw";
import httpRequestReadme from "./action-readmes/beam/http-request/README.md?raw";
import objectStorageDeleteReadme from "./action-readmes/beam/object-storage-delete/README.md?raw";
import objectStorageEndpointReadme from "./action-readmes/beam/object-storage-endpoint/README.md?raw";
import slackReadme from "./action-readmes/beam/slack/README.md?raw";
import transferReadme from "./action-readmes/beam/transfer/README.md?raw";
import uploadReadme from "./action-readmes/beam/upload/README.md?raw";
import webhookReadme from "./action-readmes/beam/webhook/README.md?raw";
import zapierReadme from "./action-readmes/beam/zapier/README.md?raw";

export const actionReadmes: Record<string, string> = {
  "@beam/download": downloadReadme,
  "@beam/http-request": httpRequestReadme,
  "@beam/object-storage-delete": objectStorageDeleteReadme,
  "@beam/object-storage-endpoint": objectStorageEndpointReadme,
  "@beam/slack": slackReadme,
  "@beam/transfer": transferReadme,
  "@beam/upload": uploadReadme,
  "@beam/webhook": webhookReadme,
  "@beam/zapier": zapierReadme,
};
