<script setup>
import { ref, onMounted, computed } from 'vue';
import { api, redirectToAuth, shopFromLocation, ApiError } from './lib/api.js';
import RuleEditor from './components/RuleEditor.vue';
import RunHistory from './components/RunHistory.vue';

const booting = ref(true);
const fatal = ref('');
const shop = ref(null);
const rules = ref([]);
const tags = ref([]);
const toast = ref(null);
const editing = ref(null); // null = closed, false = new rule, object = edit
const busyRuleId = ref(null);
const historyRef = ref(null);

const STATUS_TONE = {
  success: 'success',
  no_change: 'info',
  skipped: 'warning',
  error: 'critical',
};

function flash(message, tone = 'success') {
  toast.value = { message, tone };
  window.setTimeout(() => {
    if (toast.value?.message === message) toast.value = null;
  }, 6000);
}

async function loadRules() {
  const data = await api.rules();
  rules.value = data.rules;
}

onMounted(async () => {
  try {
    const me = await api.me();
    shop.value = me;
    await loadRules();
    try {
      tags.value = (await api.tags()).tags;
    } catch {
      tags.value = [];
    }
  } catch (err) {
    // Either the app isn't installed on this shop yet, or App Bridge never came
    // up. Both are fixed by running the install flow, provided we can work out
    // which shop we're dealing with.
    const target = (err instanceof ApiError && err.body?.shop) || shopFromLocation();
    const needsAuth = err instanceof ApiError && (err.body?.reauthorize || err.status === 0);

    if (needsAuth && target) {
      try {
        redirectToAuth(target);
        return;
      } catch {
        /* fall through to the error state */
      }
    }
    fatal.value = err.message || 'Could not start the app.';
  } finally {
    booting.value = false;
  }
});

async function toggle(rule) {
  busyRuleId.value = rule.id;
  try {
    const data = await api.setEnabled(rule.id, !rule.enabled);
    const i = rules.value.findIndex((r) => r.id === rule.id);
    if (i >= 0) rules.value[i] = data.rule;
  } catch (err) {
    flash(err.message, 'critical');
  } finally {
    busyRuleId.value = null;
  }
}

async function runNow(rule) {
  busyRuleId.value = rule.id;
  try {
    const { result } = await api.runRule(rule.id);
    const tone = result.status === 'error' ? 'critical' : result.status === 'skipped' ? 'warning' : 'success';
    flash(`${rule.name}: ${result.message}`, tone);
    await loadRules();
    historyRef.value?.load();
  } catch (err) {
    flash(err.message, 'critical');
  } finally {
    busyRuleId.value = null;
  }
}

async function remove(rule) {
  if (!window.confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;
  busyRuleId.value = rule.id;
  try {
    await api.deleteRule(rule.id);
    rules.value = rules.value.filter((r) => r.id !== rule.id);
    flash('Rule deleted.');
  } catch (err) {
    flash(err.message, 'critical');
  } finally {
    busyRuleId.value = null;
  }
}

async function onSaved(rule) {
  const i = rules.value.findIndex((r) => r.id === rule.id);
  if (i >= 0) rules.value[i] = rule;
  else rules.value.unshift(rule);
  editing.value = null;
  flash(`Rule "${rule.name}" saved.`);
}

function nextRunLabel(rule) {
  if (!rule.enabled) return 'Paused';
  return `Daily at ${rule.runAt} (${rule.timezone})`;
}

function lastRunLabel(rule) {
  if (!rule.lastRunAt) return 'Never run';
  const when = new Date(rule.lastRunAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Last run ${when}`;
}

const activeCount = computed(() => rules.value.filter((r) => r.enabled).length);
</script>

<template>
  <div class="page">
    <div v-if="booting" class="empty">
      <span class="spinner"></span>
      <p class="tiny subtle" style="margin-top: 10px">Loading…</p>
    </div>

    <div v-else-if="fatal" class="banner critical">
      <div>
        <strong>Something went wrong.</strong>
        <p>{{ fatal }}</p>
        <p class="tiny" style="margin-top: 6px">
          If you opened this outside the Shopify admin, open it from Apps in your store instead.
        </p>
      </div>
    </div>

    <template v-else>
      <div class="page-header">
        <div>
          <h1>Collection sorting scheduler</h1>
          <p class="subtle tiny">
            {{ shop.name || shop.shop }} · store timezone {{ shop.timezone }} ·
            {{ activeCount }} of {{ rules.length }} rules active
          </p>
        </div>
        <button class="primary" @click="editing = false">Create rule</button>
      </div>

      <div v-if="toast" class="banner" :class="toast.tone">{{ toast.message }}</div>

      <div v-if="!rules.length" class="card empty">
        <h2>No rules yet</h2>
        <p class="tiny" style="margin: 8px 0 16px">
          Create a rule to reorder a collection automatically once a day — for example, moving every
          product tagged “new” to the top.
        </p>
        <button class="primary" @click="editing = false">Create your first rule</button>
      </div>

      <div v-else class="card card-tight">
        <div v-for="rule in rules" :key="rule.id" class="rule">
          <label class="switch" style="padding-top: 2px">
            <input
              type="checkbox"
              :checked="rule.enabled"
              :disabled="busyRuleId === rule.id"
              @change="toggle(rule)"
            />
            <span class="track"></span>
            <span class="sr-only">Enable {{ rule.name }}</span>
          </label>

          <div class="rule-main">
            <div class="rule-title">
              {{ rule.name }}
              <span v-if="!rule.enabled" class="badge">Paused</span>
              <span v-if="rule.lastStatus" class="badge" :class="STATUS_TONE[rule.lastStatus]">
                {{ rule.lastStatus.replace('_', ' ') }}
              </span>
            </div>
            <div class="rule-summary">
              <strong>{{ rule.collectionTitle || 'Collection' }}</strong> — {{ rule.summary }}
            </div>
            <div class="rule-meta">
              <span>{{ nextRunLabel(rule) }}</span>
              <span>·</span>
              <span>{{ lastRunLabel(rule) }}</span>
            </div>
          </div>

          <div class="row-tight">
            <span v-if="busyRuleId === rule.id" class="spinner"></span>
            <button class="small" :disabled="busyRuleId === rule.id" @click="runNow(rule)">
              Run now
            </button>
            <button class="small" :disabled="busyRuleId === rule.id" @click="editing = rule">
              Edit
            </button>
            <button class="small danger" :disabled="busyRuleId === rule.id" @click="remove(rule)">
              Delete
            </button>
          </div>
        </div>
      </div>

      <RunHistory ref="historyRef" />

      <RuleEditor
        v-if="editing !== null"
        :rule="editing || null"
        :shop-timezone="shop.timezone"
        :tags="tags"
        @close="editing = null"
        @saved="onSaved"
      />
    </template>
  </div>
</template>
