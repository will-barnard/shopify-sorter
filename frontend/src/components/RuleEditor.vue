<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { api } from '../lib/api.js';
import TagInput from './TagInput.vue';
import CollectionPicker from './CollectionPicker.vue';

const props = defineProps({
  rule: { type: Object, default: null },
  shopTimezone: { type: String, default: 'UTC' },
  tags: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'saved']);

const BASE_OPTIONS = [
  { value: 'current', label: 'Keep the current manual order' },
  { value: 'best_selling', label: 'Best selling first' },
  { value: 'newest', label: 'Newest products first' },
  { value: 'oldest', label: 'Oldest products first' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'title_asc', label: 'Title: A–Z' },
  { value: 'title_desc', label: 'Title: Z–A' },
  { value: 'inventory_desc', label: 'Inventory: high to low' },
  { value: 'inventory_asc', label: 'Inventory: low to high' },
];

const GROUP_LABELS = {
  tag: 'Products with tags',
  out_of_stock: 'Out-of-stock products',
  draft: 'Unavailable products (draft/archived)',
};

const form = reactive({
  name: '',
  collectionId: '',
  collectionTitle: '',
  enabled: true,
  runAt: '03:00',
  timezone: props.shopTimezone || 'UTC',
  forceManualSort: true,
  strategy: { base: 'current', groups: [] },
});

const timezones = ref([]);
const saving = ref(false);
const error = ref('');
const preview = ref(null);
const previewing = ref(false);
const previewError = ref('');

const isEdit = computed(() => !!props.rule);

onMounted(async () => {
  if (props.rule) {
    Object.assign(form, {
      name: props.rule.name,
      collectionId: props.rule.collectionId,
      collectionTitle: props.rule.collectionTitle,
      enabled: props.rule.enabled,
      runAt: props.rule.runAt,
      timezone: props.rule.timezone,
      forceManualSort: props.rule.forceManualSort,
      strategy: JSON.parse(JSON.stringify(props.rule.strategy || { base: 'current', groups: [] })),
    });
  } else {
    // Sensible default for the most common job: tagged products to the top.
    form.strategy.groups.push({ type: 'tag', tags: [], match: 'any', position: 'top' });
  }

  try {
    const data = await api.timezones();
    timezones.value = data.timezones;
  } catch {
    timezones.value = [form.timezone, 'UTC'];
  }
});

function addGroup() {
  form.strategy.groups.push({ type: 'tag', tags: [], match: 'any', position: 'top' });
}

function removeGroup(i) {
  form.strategy.groups.splice(i, 1);
}

function moveGroup(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= form.strategy.groups.length) return;
  const groups = form.strategy.groups;
  [groups[i], groups[j]] = [groups[j], groups[i]];
}

function onGroupTypeChange(group) {
  if (group.type === 'tag') {
    if (!Array.isArray(group.tags)) group.tags = [];
    if (!group.match) group.match = 'any';
  } else {
    delete group.tags;
    delete group.match;
  }
}

function payload() {
  return {
    name: form.name.trim() || `Sort ${form.collectionTitle || 'collection'}`,
    collectionId: form.collectionId,
    collectionTitle: form.collectionTitle,
    enabled: form.enabled,
    runAt: form.runAt,
    timezone: form.timezone,
    forceManualSort: form.forceManualSort,
    strategy: form.strategy,
  };
}

async function save() {
  error.value = '';
  if (!form.collectionId) {
    error.value = 'Pick a collection first.';
    return;
  }
  saving.value = true;
  try {
    const body = payload();
    const data = isEdit.value
      ? await api.updateRule(props.rule.id, body)
      : await api.createRule(body);
    emit('saved', data.rule);
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function runPreview() {
  previewError.value = '';
  preview.value = null;
  if (!form.collectionId) {
    previewError.value = 'Pick a collection first.';
    return;
  }
  previewing.value = true;
  try {
    preview.value = await api.preview(form.collectionId, form.strategy);
  } catch (err) {
    previewError.value = err.message;
  } finally {
    previewing.value = false;
  }
}

// The preview goes stale the moment the strategy changes.
watch(
  () => JSON.stringify(form.strategy) + form.collectionId,
  () => {
    preview.value = null;
  }
);

const movedIds = computed(() => {
  if (!preview.value) return new Set();
  const before = preview.value.before.map((p) => p.id);
  const after = preview.value.after.map((p) => p.id);
  const moved = new Set();
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) moved.add(after[i]);
  return moved;
});
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>{{ isEdit ? 'Edit rule' : 'New sorting rule' }}</h2>
        <div class="spacer"></div>
        <button type="button" class="plain" @click="emit('close')">Close</button>
      </div>

      <div class="modal-body stack">
        <div v-if="error" class="banner critical" style="margin-bottom: 0">{{ error }}</div>

        <label class="field">
          <span>Rule name</span>
          <input v-model="form.name" type="text" placeholder="e.g. Feature new arrivals" />
        </label>

        <CollectionPicker
          v-model="form.collectionId"
          v-model:title="form.collectionTitle"
        />

        <div>
          <h3 style="margin-bottom: 8px">Sorting</h3>
          <div class="stack">
            <label class="field">
              <span>Start from</span>
              <select v-model="form.strategy.base">
                <option v-for="opt in BASE_OPTIONS" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </label>

            <div
              v-for="(group, i) in form.strategy.groups"
              :key="i"
              class="group"
            >
              <div class="group-head">
                <span class="group-index">{{ i + 1 }}</span>
                <select
                  v-model="group.type"
                  style="width: auto; flex: 1"
                  @change="onGroupTypeChange(group)"
                >
                  <option v-for="(label, value) in GROUP_LABELS" :key="value" :value="value">
                    {{ label }}
                  </option>
                </select>
                <select v-model="group.position" style="width: auto">
                  <option value="top">to the top</option>
                  <option value="bottom">to the bottom</option>
                </select>
                <button
                  type="button"
                  class="small"
                  :disabled="i === 0"
                  title="Move up"
                  @click="moveGroup(i, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="small"
                  :disabled="i === form.strategy.groups.length - 1"
                  title="Move down"
                  @click="moveGroup(i, 1)"
                >
                  ↓
                </button>
                <button type="button" class="small danger" @click="removeGroup(i)">Remove</button>
              </div>

              <div v-if="group.type === 'tag'" class="stack-sm">
                <TagInput v-model="group.tags" :suggestions="tags" />
                <div class="row-tight tiny subtle">
                  <span>Match</span>
                  <select v-model="group.match" style="width: auto" class="tiny">
                    <option value="any">any of these tags</option>
                    <option value="all">all of these tags</option>
                  </select>
                </div>
              </div>
            </div>

            <button type="button" @click="addGroup">+ Add another group</button>

            <p class="tiny subtle">
              Groups are checked in order and the first match wins, so group 1 has the strongest
              claim on a product. Products matching nothing stay in the middle.
            </p>
          </div>
        </div>

        <div>
          <h3 style="margin-bottom: 8px">Schedule</h3>
          <div class="grid-2">
            <label class="field">
              <span>Run daily at</span>
              <input v-model="form.runAt" type="time" step="60" />
            </label>
            <label class="field">
              <span>Timezone</span>
              <select v-model="form.timezone">
                <option v-for="tz in timezones" :key="tz" :value="tz">{{ tz }}</option>
              </select>
            </label>
          </div>
        </div>

        <label class="switch">
          <input v-model="form.enabled" type="checkbox" />
          <span class="track"></span>
          <span>Rule is active</span>
        </label>

        <label class="switch">
          <input v-model="form.forceManualSort" type="checkbox" />
          <span class="track"></span>
          <span>Switch the collection to manual sorting if it isn't already</span>
        </label>
        <p class="tiny subtle" style="margin-top: -6px">
          Shopify only allows reordering on manually sorted collections. Without this the rule is
          skipped instead.
        </p>

        <div>
          <div class="row" style="margin-bottom: 8px">
            <h3>Preview</h3>
            <div class="spacer"></div>
            <button type="button" class="small" :disabled="previewing" @click="runPreview">
              {{ previewing ? 'Checking…' : 'Preview changes' }}
            </button>
          </div>

          <div v-if="previewError" class="banner critical">{{ previewError }}</div>

          <div v-else-if="preview" class="stack-sm">
            <div class="row tiny subtle">
              <span
                ><strong>{{ preview.changed }}</strong> of {{ preview.productsCount }} products would
                change position</span
              >
              <span v-if="preview.sortOrder !== 'MANUAL'" class="badge warning">
                Collection is {{ preview.sortOrder }}
              </span>
            </div>
            <p v-if="preview.approximate" class="tiny subtle">
              Best-selling order is resolved by Shopify at run time, so this preview shows the
              grouping only.
            </p>

            <div class="preview-cols">
              <div>
                <p class="tiny subtle" style="margin-bottom: 4px">Now (first 20)</p>
                <div class="plist">
                  <div v-for="(p, i) in preview.before" :key="p.id" class="pitem">
                    <span class="idx">{{ i + 1 }}</span>
                    <img v-if="p.image" :src="p.image" alt="" />
                    <span class="pname">{{ p.title }}</span>
                  </div>
                </div>
              </div>
              <div>
                <p class="tiny subtle" style="margin-bottom: 4px">After the rule runs</p>
                <div class="plist">
                  <div
                    v-for="(p, i) in preview.after"
                    :key="p.id"
                    class="pitem"
                    :class="{ moved: movedIds.has(p.id) }"
                  >
                    <span class="idx">{{ i + 1 }}</span>
                    <img v-if="p.image" :src="p.image" alt="" />
                    <span class="pname">{{ p.title }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p v-else class="tiny subtle">
            Preview reads the collection and shows the result without changing anything.
          </p>
        </div>
      </div>

      <div class="modal-foot">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule' }}
        </button>
      </div>
    </div>
  </div>
</template>
