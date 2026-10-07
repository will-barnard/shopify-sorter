<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, redirectToAuth } from '../lib/api.js';

const loading = ref(true);
const error = ref('');
const saving = ref(false);
const working = ref('');
const notice = ref(null); // { tone, message }
const scopeOk = ref(true);
const requiredScope = ref('read_inventory');
const events = ref([]);
const preview = ref(null);

const form = ref({ enabled: false, tag: '', noticeText: '', sweepAt: '04:00' });
const saved = ref(null);

const dirty = computed(
  () =>
    !!saved.value &&
    (form.value.enabled !== saved.value.enabled ||
      form.value.tag !== saved.value.tag ||
      form.value.noticeText !== saved.value.noticeText ||
      form.value.sweepAt !== saved.value.sweepAt)
);

const ACTION_LABEL = {
  added: 'Notice added',
  removed: 'Notice removed',
  repositioned: 'Notice moved to top',
  error: 'Error',
};
const ACTION_TONE = { added: 'success', removed: 'info', repositioned: 'info', error: 'critical' };

function apply(settings) {
  saved.value = { ...settings };
  form.value = {
    enabled: settings.enabled,
    tag: settings.tag,
    noticeText: settings.noticeText,
    sweepAt: settings.sweepAt,
  };
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.leadTime();
    apply(data.settings);
    scopeOk.value = data.scopeOk;
    requiredScope.value = data.requiredScope;
    events.value = data.events;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function refreshEvents() {
  try {
    events.value = (await api.leadTime()).events;
  } catch {
    /* keep the old list */
  }
}

async function save() {
  saving.value = true;
  notice.value = null;
  try {
    const { settings } = await api.saveLeadTime({ ...form.value });
    apply(settings);
    preview.value = null;
    notice.value = {
      tone: 'success',
      message: settings.enabled
        ? 'Saved. Inventory changes on tagged products now update the description.'
        : 'Saved. The notice is off; no descriptions will be changed.',
    };
  } catch (err) {
    notice.value = { tone: 'critical', message: err.message };
  } finally {
    saving.value = false;
  }
}

async function runPreview() {
  working.value = 'preview';
  notice.value = null;
  try {
    // Previews the form as it stands, so an unsaved tag or wording can be checked first.
    const { summary } = await api.previewLeadTime({
      tag: form.value.tag,
      noticeText: form.value.noticeText,
    });
    preview.value = summary;
  } catch (err) {
    notice.value = { tone: 'critical', message: err.message };
  } finally {
    working.value = '';
  }
}

async function runNow() {
  working.value = 'run';
  notice.value = null;
  try {
    const { summary } = await api.runLeadTime();
    preview.value = null;
    notice.value = {
      tone: summary.errors ? 'warning' : 'success',
      message: `Checked ${summary.checked} product${summary.checked === 1 ? '' : 's'}: ${summary.changed} changed, ${summary.errors} errors.`,
    };
    await refreshEvents();
  } catch (err) {
    notice.value = { tone: 'critical', message: err.message };
  } finally {
    working.value = '';
  }
}

function when(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

onMounted(load);
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h2>Lead-time notice</h2>
      <div class="spacer"></div>
      <span v-if="saved" class="badge" :class="saved.enabled ? 'success' : ''">
        {{ saved.enabled ? 'On' : 'Off' }}
      </span>
    </div>

    <div v-if="loading" class="empty"><span class="spinner"></span></div>
    <div v-else-if="error" class="banner critical">{{ error }}</div>

    <div v-else class="stack">
      <p class="tiny subtle">
        For products with the tag below, puts a bold line at the top of the description while every
        variant is out of stock but can still be ordered, and takes it off when stock arrives. It is
        part of the description itself, so it reaches Reverb, eBay and any other channel that syncs it.
      </p>

      <div v-if="!scopeOk" class="banner warning">
        <div>
          <strong>Needs the {{ requiredScope }} permission.</strong>
          <p class="tiny">
            Shopify only sends stock-change events to apps with that permission, so the notice would
            never update on its own. Approve it once and the app will start receiving them.
          </p>
          <button type="button" class="small" style="margin-top: 8px" @click="redirectToAuth()">
            Re-authorize app
          </button>
        </div>
      </div>

      <div v-if="notice" class="banner" :class="notice.tone">{{ notice.message }}</div>

      <label class="switch">
        <input v-model="form.enabled" type="checkbox" />
        <span class="track"></span>
        <span>Keep descriptions up to date automatically</span>
      </label>

      <div class="grid-2">
        <label class="field">
          <span>Product tag</span>
          <input v-model="form.tag" type="text" placeholder="special-order" />
        </label>
        <label class="field">
          <span>Nightly check at (store time)</span>
          <input v-model="form.sweepAt" type="time" step="60" />
        </label>
      </div>

      <label class="field">
        <span>Notice text</span>
        <input v-model="form.noticeText" type="text" maxlength="300" />
      </label>
      <p class="tiny subtle">
        Changing the wording replaces the old sentence on products the next time they update or the
        nightly check runs. Products tagged “restoration” are never touched.
      </p>

      <div class="row-tight">
        <button type="button" class="primary" :disabled="saving || !dirty" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button type="button" :disabled="!!working" @click="runPreview">
          {{ working === 'preview' ? 'Checking…' : 'Preview changes' }}
        </button>
        <button type="button" :disabled="!!working || dirty || !saved?.enabled" @click="runNow">
          {{ working === 'run' ? 'Running…' : 'Run now' }}
        </button>
      </div>

      <div v-if="preview" class="stack-sm">
        <strong class="tiny">
          Preview: {{ preview.checked }} tagged product{{ preview.checked === 1 ? '' : 's' }},
          {{ preview.changed }} would change. Nothing was written.
        </strong>
        <table v-if="preview.items.length">
          <tbody>
            <tr v-for="item in preview.items" :key="item.id">
              <td>{{ item.title || item.id }}</td>
              <td>
                <span class="badge" :class="item.outcome === 'would-change' ? 'warning' : ''">
                  {{ item.outcome === 'would-change' ? `Would ${item.action.replace('repositioned', 'move').replace('added', 'add').replace('removed', 'remove')} notice` : item.outcome }}
                </span>
              </td>
              <td class="tiny subtle">{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="tiny subtle">No products carry the “{{ form.tag }}” tag yet.</p>
      </div>

      <div class="stack-sm">
        <div class="row-tight">
          <strong class="tiny">Recent changes</strong>
          <div class="spacer"></div>
          <button type="button" class="small" @click="refreshEvents">Refresh</button>
        </div>
        <p v-if="!events.length" class="tiny subtle">Nothing yet. Only actual changes and errors are listed.</p>
        <table v-else>
          <tbody>
            <tr v-for="e in events" :key="e.id">
              <td class="subtle tiny">{{ when(e.createdAt) }}</td>
              <td>{{ e.productTitle || e.productId }}</td>
              <td>
                <span class="badge" :class="ACTION_TONE[e.action]">{{ ACTION_LABEL[e.action] || e.action }}</span>
              </td>
              <td class="tiny subtle">{{ e.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
