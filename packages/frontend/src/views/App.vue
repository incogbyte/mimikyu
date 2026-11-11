<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import InputNumber from "primevue/inputnumber";
import InputText from "primevue/inputtext";
import Message from "primevue/message";
import Select from "primevue/select";
import Tag from "primevue/tag";
import ToggleSwitch from "primevue/toggleswitch";
import type { Result, Settings, TransportStatus } from "shared";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useSDK } from "../plugins/sdk";

import ActivityPanel from "./ActivityPanel.vue";

const sdk = useSDK();
const settings = ref<Settings>();
const status = ref<TransportStatus>();
const loading = ref(true);
const saving = ref(false);
const action = ref<"start" | "stop">();
const error = ref("");

const modeOptions = [
  { label: "Docker-managed Chrome", value: "docker-managed" },
  { label: "External browser via CDP", value: "external-cdp" },
];

function unwrap<T>(result: Result<T>): T {
  if (result.kind === "Error") throw new Error(result.error);
  return result.value;
}

function applySettings(value: Settings): void {
  settings.value = { ...value };
}

function applyStatus(value: TransportStatus): void {
  status.value = value;
}

const statusSeverity = computed(() => {
  switch (status.value?.state) {
    case "running":
      return status.value.browser === "connected" ? "success" : "warn";
    case "error":
    case "unsupported":
      return "danger";
    case "starting":
    case "stopping":
      return "warn";
    default:
      return "secondary";
  }
});

const statusLabel = computed(() => {
  if (!status.value) return "loading";
  if (status.value.state !== "running") return status.value.state;
  return status.value.browser === "connected"
    ? "browser connected"
    : "agent running";
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [statusResult, settingsResult] = await Promise.all([
      sdk.backend.getStatus(),
      sdk.backend.getSettings(),
    ]);
    if (statusResult.kind === "Ok") applyStatus(statusResult.value);
    else error.value = statusResult.error;
    if (settingsResult.kind === "Ok") applySettings(settingsResult.value);
    else error.value = `${error.value} ${settingsResult.error}`.trim();
  } catch (cause) {
    error.value = String(cause);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!settings.value) return;
  saving.value = true;
  error.value = "";
  try {
    applySettings(unwrap(await sdk.backend.updateSettings(settings.value)));
    sdk.window.showToast("Mimikyu settings saved", { variant: "success" });
  } catch (cause) {
    error.value = String(cause);
  } finally {
    saving.value = false;
  }
}

async function startAgent(): Promise<void> {
  action.value = "start";
  error.value = "";
  try {
    applyStatus(unwrap(await sdk.backend.startTransport()));
  } catch (cause) {
    error.value = String(cause);
  } finally {
    action.value = undefined;
  }
}

async function stopAgent(): Promise<void> {
  action.value = "stop";
  error.value = "";
  try {
    applyStatus(unwrap(await sdk.backend.stopTransport()));
  } catch (cause) {
    error.value = String(cause);
  } finally {
    action.value = undefined;
  }
}

const statusEvents = sdk.backend.onEvent("transport:status", applyStatus);
const settingsEvents = sdk.backend.onEvent("settings:updated", applySettings);
onBeforeUnmount(() => {
  statusEvents.stop();
  settingsEvents.stop();
});
onMounted(() => void load());
</script>

<template>
  <div class="h-full min-h-0 flex flex-col gap-1">
    <Card
      class="shrink-0"
      :pt="{ body: { class: 'p-0' }, content: { class: 'p-0' } }"
    >
      <template #content>
        <div class="px-4 py-3 flex items-center justify-between gap-4">
          <div class="min-w-0">
            <h3 class="text-lg font-semibold">Mimikyu</h3>
            <p class="text-sm text-surface-400">
              Persistent browser execution for Caido traffic
            </p>
          </div>
          <Tag
            :value="statusLabel"
            :severity="statusSeverity"
            class="capitalize shrink-0"
          />
        </div>
      </template>
    </Card>

    <Card
      class="flex-1 min-h-0"
      :pt="{
        root: { style: 'display: flex; flex-direction: column; height: 100%;' },
        body: { class: 'flex-1 p-0 flex flex-col min-h-0' },
        content: { class: 'flex-1 flex flex-col min-h-0' },
      }"
    >
      <template #content>
        <div class="h-full min-h-0 overflow-auto p-4">
          <div class="flex flex-col gap-5">
            <Message v-if="error !== ''" severity="error" :closable="false">{{
              error
            }}</Message>

            <Message severity="secondary" :closable="false">
              Mimikyu keeps the browser and its profile alive. Each request uses
              a background target; the browser is not opened or closed per
              request.
            </Message>

            <div v-if="settings" class="flex flex-col gap-5">
              <div class="flex items-center gap-4">
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium">Enable browser routing</div>
                  <p class="text-sm text-surface-400">
                    Route matching Caido upstream rules through Mimikyu.
                  </p>
                </div>
                <ToggleSwitch v-model="settings.enabled" :disabled="loading" />
              </div>

              <div class="flex items-center gap-4">
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium">Start with plugin</div>
                  <p class="text-sm text-surface-400">
                    Connect to the agent automatically.
                  </p>
                </div>
                <ToggleSwitch
                  v-model="settings.autoStart"
                  :disabled="loading"
                />
              </div>

              <div class="flex items-center gap-4">
                <div class="flex-1 min-w-0">
                  <label class="text-sm font-medium" for="browser-mode"
                    >Browser mode</label
                  >
                  <p class="text-sm text-surface-400">
                    Use the managed Docker browser or an external CDP browser.
                  </p>
                </div>
                <Select
                  v-model="settings.browserMode"
                  input-id="browser-mode"
                  :options="modeOptions"
                  option-label="label"
                  option-value="value"
                  class="w-64"
                />
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="text-sm font-medium" for="agent-host"
                    >Agent host</label
                  >
                  <InputText
                    id="agent-host"
                    v-model="settings.agentHost"
                    class="w-full mt-1"
                  />
                </div>
                <div>
                  <label class="text-sm font-medium" for="agent-port"
                    >Agent port</label
                  >
                  <InputNumber
                    v-model="settings.agentPort"
                    input-id="agent-port"
                    :min="0"
                    :max="65535"
                    :max-fraction-digits="0"
                    class="w-full mt-1"
                  />
                </div>
              </div>

              <div v-if="settings.browserMode === 'docker-managed'">
                <label class="text-sm font-medium" for="agent-token"
                  >Agent token</label
                >
                <p class="text-sm text-surface-400">
                  Must match the local Docker agent. Keep this value private.
                </p>
                <InputText
                  id="agent-token"
                  v-model="settings.agentToken"
                  type="password"
                  class="w-full mt-1"
                />
              </div>

              <div
                v-if="settings.browserMode === 'external-cdp'"
                class="grid grid-cols-2 gap-4"
              >
                <div>
                  <label class="text-sm font-medium" for="cdp-host"
                    >CDP host</label
                  >
                  <InputText
                    id="cdp-host"
                    v-model="settings.cdpHost"
                    class="w-full mt-1"
                  />
                </div>
                <div>
                  <label class="text-sm font-medium" for="cdp-port"
                    >CDP port</label
                  >
                  <InputNumber
                    v-model="settings.cdpPort"
                    input-id="cdp-port"
                    :min="1"
                    :max="65535"
                    :max-fraction-digits="0"
                    class="w-full mt-1"
                  />
                </div>
              </div>

              <div>
                <label class="text-sm font-medium" for="upload-limit"
                  >Maximum upload (MiB)</label
                >
                <p class="text-sm text-surface-400">
                  Use 0 for unlimited. The first MVP still limits browser
                  uploads.
                </p>
                <InputNumber
                  v-model="settings.maximumUploadMiB"
                  input-id="upload-limit"
                  :min="0"
                  :max="1048576"
                  :max-fraction-digits="0"
                  class="w-full mt-1"
                />
              </div>

              <div class="flex items-center gap-2">
                <Button
                  label="Save settings"
                  icon="fas fa-save"
                  :loading="saving"
                  @click="save"
                />
                <Button
                  label="Start"
                  icon="fas fa-play"
                  severity="secondary"
                  outlined
                  :loading="action === 'start'"
                  :disabled="
                    action !== undefined || status?.state === 'running'
                  "
                  @click="startAgent"
                />
                <Button
                  label="Stop"
                  icon="fas fa-stop"
                  severity="secondary"
                  text
                  :loading="action === 'stop'"
                  :disabled="action !== undefined || status?.state === 'idle'"
                  @click="stopAgent"
                />
              </div>
            </div>

            <ActivityPanel />
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>
