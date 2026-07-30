<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../lib/api.js';

const runs = ref([]);
const loading = ref(true);
const error = ref('');

const STATUS_TONE = {
  success: 'success',
  no_change: 'info',
  skipped: 'warning',
  error: 'critical',
  running: '',
};

const STATUS_LABEL = {
  success: 'Reordered',
  no_change: 'No change',
  skipped: 'Skipped',
  error: 'Failed',
  running: 'Running',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.runs();
    runs.value = data.runs;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <div class="card card-tight">
    <div class="card-head" style="padding: 16px 16px 0; margin-bottom: 12px">
      <h2>Run history</h2>
      <div class="spacer"></div>
      <button type="button" class="small" :disabled="loading" @click="load">Refresh</button>
    </div>

    <div v-if="error" class="banner critical" style="margin: 0 16px 16px">{{ error }}</div>

    <div v-else-if="loading" class="empty"><span class="spinner"></span></div>

    <div v-else-if="!runs.length" class="empty">
      <p>No runs yet.</p>
      <p class="tiny">Rules appear here after they run on schedule or via “Run now”.</p>
    </div>

    <table v-else>
      <thead>
        <tr>
          <th>Rule</th>
          <th>When</th>
          <th>Trigger</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.id">
          <td>{{ run.ruleName }}</td>
          <td class="subtle tiny">{{ when(run.startedAt) }}</td>
          <td class="subtle tiny">{{ run.trigger === 'manual' ? 'Manual' : 'Scheduled' }}</td>
          <td>
            <div class="stack-sm">
              <span class="badge" :class="STATUS_TONE[run.status]">
                {{ STATUS_LABEL[run.status] || run.status }}
              </span>
              <span v-if="run.message" class="tiny subtle">{{ run.message }}</span>
              <span v-if="run.productsCount" class="tiny subtle">
                {{ run.movesCount }} moved of {{ run.productsCount }} products
              </span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
