import type { ActionExecute, ActionManifest } from "./actions.js";
import {
  httpRequestAction,
  httpRequestActionManifest,
} from "./builtin-actions/beam/http-request.js";
import {
  slackAction,
  slackActionManifest,
} from "./builtin-actions/beam/slack.js";
import {
  fanOutAction,
  fanOutActionManifest,
  joinAction,
  joinActionManifest,
} from "./builtin-actions/beam/control-flow.js";
import {
  downloadAction,
  downloadActionManifest,
} from "./builtin-actions/beam/download.js";
import {
  salesforceQueryAction,
  salesforceQueryActionManifest,
} from "./builtin-actions/beam/salesforce-query.js";
import {
  salesforceUpsertAction,
  salesforceUpsertActionManifest,
} from "./builtin-actions/beam/salesforce-upsert.js";
import {
  salesforceRecordAction,
  salesforceRecordActionManifest,
} from "./builtin-actions/beam/salesforce-record.js";
import {
  salesforceRestAction,
  salesforceRestActionManifest,
} from "./builtin-actions/beam/salesforce-rest.js";
import {
  uploadAction,
  uploadActionManifest,
} from "./builtin-actions/beam/upload.js";
import {
  huggingFaceEndpointAction,
  huggingFaceEndpointActionManifest,
} from "./builtin-actions/beam/huggingface-endpoint.js";
import {
  objectStorageEndpointAction,
  objectStorageEndpointActionManifest,
  originalObjectStorageEndpointAction,
} from "./builtin-actions/beam/object-storage-endpoint.js";
import {
  objectStorageDeleteAction,
  objectStorageDeleteActionManifest,
} from "./builtin-actions/beam/object-storage-delete.js";
import {
  webhookAction,
  webhookActionManifest,
} from "./builtin-actions/beam/webhook.js";
import {
  zapierAction,
  zapierActionManifest,
  zapierToolsAction,
  zapierToolsActionManifest,
} from "./builtin-actions/beam/zapier.js";

export {
  downloadActionManifest,
  fanOutActionManifest,
  huggingFaceEndpointActionManifest,
  httpRequestActionManifest,
  joinActionManifest,
  objectStorageDeleteActionManifest,
  objectStorageEndpointActionManifest,
  slackActionManifest,
  salesforceQueryActionManifest,
  salesforceRecordActionManifest,
  salesforceRestActionManifest,
  salesforceUpsertActionManifest,
  uploadActionManifest,
  webhookActionManifest,
  zapierActionManifest,
  zapierToolsActionManifest,
};

export const builtinDataActions = [
  slackAction,
  fanOutAction,
  joinAction,
  objectStorageEndpointAction,
  originalObjectStorageEndpointAction,
  huggingFaceEndpointAction,
  objectStorageDeleteAction,
  downloadAction,
  uploadAction,
  httpRequestAction,
  webhookAction,
  salesforceQueryAction,
  salesforceUpsertAction,
  salesforceRecordAction,
  salesforceRestAction,
  zapierAction,
  zapierToolsAction,
] satisfies Array<{ manifest: ActionManifest; execute: ActionExecute }>;
