import { WorkflowExecutionTargetSettings } from "./workflow-execution-target-settings";
import { Switch } from "@/components/ui/switch";
import { ActionSettingsTabs } from "./workflow-action-settings-tabs";
import { RoomTransferConfigForm } from "./room-transfer-config-form";
import { useEffect, useState } from "react";
import type { Node } from "@xyflow/react";
import { cn } from "@/lib/utils";
import {
  arrayItemType,
  arrayStringValue,
  configSchemaFields,
  credentialConfigFields,
  defaultConfigValue,
  parseStringList,
  schemaEnumValues,
  schemaLabel,
  schemaType,
  stringValue,
} from "./workflow-config-schema";
import {
  FieldRow,
  NativeSelect,
  TextArea,
  TextInput,
  ToggleRow,
} from "./workflow-form-controls";
import {
  BEAM_TRANSFER_ACTION,
  ZAPIER_ACTION,
} from "./workflow-graph-constants";
import { DescriptionGrid, JsonInline } from "./workflow-shared-ui";
import { InputBindingsEditor } from "./workflow-input-bindings-editor";
import { ZapierToolField } from "./workflow-zapier-tool-field";
import type {
  CredentialRecord,
  JsonObject,
  WorkflowCanvasNodeData,
  WorkflowNodeData,
} from "./workflow-graph-types";

export function ActionNodeSettings({
  credentials,
  node,
  nodes,
  onChange,
}: {
  credentials: CredentialRecord[];
  node: Node<WorkflowNodeData>;
  nodes: Node<WorkflowCanvasNodeData>[];
  onChange(patch: Partial<WorkflowNodeData>): void;
}) {
  const manifest = node.data.action?.manifest ?? node.data.manifest ?? {};

  return (
    <ActionSettingsTabs
      issues={node.data.issues}
      name={
        <FieldRow
          label="Name"
          hint="Shown on the canvas and available downstream as ${steps.<id>.name}."
        >
          <TextInput
            placeholder={
              stringValue(manifest.displayName) || node.data.actionPackageName
            }
            value={node.data.name ?? ""}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </FieldRow>
      }
      configuration={
        node.data.actionPackageName === BEAM_TRANSFER_ACTION ? (
          <BeamTransferConfigForm
            config={node.data.config}
            credentials={credentials}
            onChange={(config) => onChange({ config })}
          />
        ) : node.data.actionPackageName === "@beam/room-transfer" ? (
          <RoomTransferConfigForm
            workflowRoom={node.data.workflowRoom}
            config={node.data.config}
            onChange={(config) => onChange({ config })}
          />
        ) : (
          <ActionConfigForm
            actionPackageName={node.data.actionPackageName}
            config={node.data.config}
            credentials={credentials}
            manifest={manifest}
            onChange={(config) => onChange({ config })}
          />
        )
      }
      inputs={
        <div className="grid gap-4">
          <p className="text-xs leading-5 text-muted-foreground">
            Only inputs resolve <code>{"${…}"}</code> expressions. Values in
            Configuration are sent to the action exactly as written.
          </p>
          <InputBindingsEditor
            node={node}
            nodes={nodes}
            onChange={(inputBindings) => onChange({ inputBindings })}
          />
        </div>
      }
      settings={
        <div className="grid gap-6">
          <WorkflowExecutionTargetSettings
            data={node.data}
            onChange={onChange}
          />
          <div className="grid gap-4">
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              Enabled
              <Switch
                checked={node.data.enabled}
                onCheckedChange={(checked) => onChange({ enabled: checked })}
              />
            </label>
            <FieldRow
              label="On failure"
              hint={
                node.data.required === false
                  ? "The error remains visible. Following actions may still fail if they need a missing result."
                  : "An unhandled failure in this action fails the workflow."
              }
            >
              <NativeSelect
                value={node.data.required === false ? "continue" : "fail"}
                onChange={(event) =>
                  onChange({ required: event.target.value === "fail" })
                }
              >
                <option value="fail">Fail workflow</option>
                <option value="continue">Continue workflow</option>
              </NativeSelect>
            </FieldRow>
          </div>
          <div className="grid gap-3 border-t pt-5">
            <h3 className="text-xs font-medium text-muted-foreground">
              Step details
            </h3>
            <DescriptionGrid
              items={[
                [
                  "Step ID",
                  <code className="break-all" key="id">
                    {node.id}
                  </code>,
                ],
                ["Version", node.data.actionVersionRange],
                ["Placement", node.data.placement],
              ]}
            />
          </div>
        </div>
      }
    />
  );
}

function BeamTransferConfigForm({
  config,
  credentials,
  onChange,
}: {
  config: JsonObject;
  credentials: CredentialRecord[];
  onChange(config: JsonObject): void;
}) {
  const beamCredentials = credentials.filter(
    (credential) => credential.kind === "beam",
  );
  const credentialId = stringValue(config.credentialId);

  useEffect(() => {
    if (!Object.hasOwn(config, "transferTemplateId")) {
      return;
    }
    const nextConfig = { ...config };
    delete nextConfig.transferTemplateId;
    onChange(nextConfig);
  }, [config, onChange]);

  return (
    <div className="grid gap-4">
      <span className="text-sm font-medium">Configuration</span>
      <FieldRow label="Beam credential">
        <NativeSelect
          value={credentialId || "__none__"}
          onChange={(event) =>
            onChange({
              ...config,
              credentialId:
                event.target.value === "__none__" ? "" : event.target.value,
            })
          }
        >
          <option value="__none__">No Beam credential</option>
          {beamCredentials.map((credential) => (
            <option key={credential.id} value={credential.id}>
              {credential.name || credential.id}
              {credential.managedBy === "studio-instance"
                ? " (instance default)"
                : ""}
            </option>
          ))}
        </NativeSelect>
        {!beamCredentials.length ? (
          <span className="text-xs font-normal text-muted-foreground">
            Create a Beam API key credential before running this transfer.
          </span>
        ) : null}
      </FieldRow>
    </div>
  );
}

function ActionConfigForm({
  actionPackageName,
  config,
  credentials,
  manifest,
  onChange,
}: {
  actionPackageName: string;
  config: JsonObject;
  credentials: CredentialRecord[];
  manifest: JsonObject;
  onChange(config: JsonObject): void;
}) {
  const fields = configSchemaFields(manifest);
  const credentialFields = credentialConfigFields(manifest);

  if (!fields.length) {
    return (
      <div className="rounded-control border border-dashed p-4 text-sm text-muted-foreground">
        No configurable parameters.
      </div>
    );
  }

  function updateField(name: string, value: unknown) {
    onChange({ ...config, [name]: value });
  }

  return (
    <div className="grid gap-4">
      <span className="text-sm font-medium">Configuration</span>
      <div className="grid gap-3">
        {fields.map(([name, schema]) =>
          // Zapier's tool names live on the user's own MCP server, so this one
          // field is fetched rather than typed from memory.
          actionPackageName === ZAPIER_ACTION && name === "tool" ? (
            <ZapierToolField
              key={name}
              credentialId={stringValue(config.credentialId)}
              label={schemaLabel(name, schema)}
              value={stringValue(config[name])}
              onChange={(value) => updateField(name, value)}
            />
          ) : credentialFields.has(name) ? (
            <CredentialConfigField
              key={name}
              acceptedTypes={credentialFields.get(name) ?? []}
              credentials={credentials}
              label={schemaLabel(name, schema)}
              value={stringValue(config[name])}
              onChange={(value) => updateField(name, value)}
            />
          ) : (
            <ConfigField
              key={name}
              name={name}
              schema={schema}
              value={
                Object.hasOwn(config, name)
                  ? config[name]
                  : defaultConfigValue(schema)
              }
              onChange={(value) => updateField(name, value)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A config key the manifest declares as a credential reference.
 *
 * The stored value is a credential id, so offering the credentials the action
 * accepts is both quicker and safer than asking for one to be pasted. A
 * credential that no longer exists still renders as an option so that editing
 * an unrelated field cannot silently drop it.
 */
function CredentialConfigField({
  acceptedTypes,
  credentials,
  label,
  onChange,
  value,
}: {
  acceptedTypes: string[];
  credentials: CredentialRecord[];
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const matching = acceptedTypes.length
    ? credentials.filter((credential) =>
        acceptedTypes.includes(credential.credentialType ?? ""),
      )
    : credentials;
  const missing = value && !matching.some((entry) => entry.id === value);

  return (
    <FieldRow label={label}>
      <NativeSelect
        value={value || "__none__"}
        onChange={(event) =>
          onChange(event.target.value === "__none__" ? "" : event.target.value)
        }
      >
        <option value="__none__">No credential</option>
        {matching.map((credential) => (
          <option key={credential.id} value={credential.id}>
            {credential.name || credential.id}
          </option>
        ))}
        {missing ? <option value={value}>{value} (unavailable)</option> : null}
      </NativeSelect>
      {!matching.length ? (
        <span className="text-xs font-normal text-muted-foreground">
          No matching credential yet. Create one under Credentials, then pick it
          here.
        </span>
      ) : null}
    </FieldRow>
  );
}

function ConfigField({
  name,
  onChange,
  schema,
  value,
}: {
  name: string;
  schema: JsonObject;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const label = schemaLabel(name, schema);
  const description = stringValue(schema.description);
  const enumValues = schemaEnumValues(schema);
  const type = schemaType(schema);

  if (type === "boolean" && !enumValues.length) {
    return (
      <div className="grid gap-1">
        <ToggleRow
          checked={Boolean(value)}
          label={label}
          onCheckedChange={onChange}
        />
        {description ? (
          <span className="text-xs font-normal text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <FieldRow label={label}>
      {enumValues.length ? (
        <NativeSelect
          value={stringValue(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {enumValues.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      ) : type === "number" || type === "integer" ? (
        <TextInput
          type="number"
          value={typeof value === "number" ? String(value) : stringValue(value)}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
        />
      ) : type === "array" && arrayItemType(schema) === "string" ? (
        <TextArea
          value={arrayStringValue(value)}
          onChange={(event) => onChange(parseStringList(event.target.value))}
        />
      ) : type === "object" || type === "array" ? (
        <JsonConfigTextarea value={value} onChange={onChange} />
      ) : (
        <TextInput
          value={stringValue(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description ? (
        <span className="text-xs font-normal text-muted-foreground">
          {description}
        </span>
      ) : null}
    </FieldRow>
  );
}

function JsonConfigTextarea({
  onChange,
  value,
}: {
  value: unknown;
  onChange(value: unknown): void;
}) {
  const [draft, setDraft] = useState(() =>
    JSON.stringify(value ?? {}, null, 2),
  );
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(JSON.stringify(value ?? {}, null, 2));
    setInvalid(false);
  }, [value]);

  return (
    <div className="grid gap-2">
      <TextArea
        className={cn(
          "min-h-28 font-mono text-xs",
          invalid && "border-destructive focus-visible:ring-destructive",
        )}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            onChange(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid ? (
        <span className="text-xs text-destructive">Invalid JSON.</span>
      ) : null}
    </div>
  );
}
