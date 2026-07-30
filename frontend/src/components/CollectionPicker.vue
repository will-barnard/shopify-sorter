<script setup>
import { ref, watch, onMounted } from 'vue';
import { api } from '../lib/api.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  title: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'update:title']);

const search = ref('');
const collections = ref([]);
const loading = ref(false);
const error = ref('');
let debounce = null;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await api.collections(search.value);
    collections.value = data.collections;
    // Keep the currently selected collection visible even if it's filtered out.
    if (props.modelValue && !collections.value.some((c) => c.id === props.modelValue)) {
      collections.value = [
        { id: props.modelValue, title: props.title || 'Selected collection', sortOrder: null, productsCount: null },
        ...collections.value,
      ];
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(search, () => {
  clearTimeout(debounce);
  debounce = window.setTimeout(load, 300);
});

function onSelect(event) {
  const id = event.target.value;
  const found = collections.value.find((c) => c.id === id);
  emit('update:modelValue', id);
  emit('update:title', found?.title || '');
}

onMounted(load);

defineExpose({ collections });
</script>

<template>
  <div class="stack-sm">
    <label class="field">
      <span>Collection</span>
      <input v-model="search" type="search" placeholder="Search collections by title…" />
    </label>

    <select :value="modelValue" @change="onSelect">
      <option value="" disabled>
        {{ loading ? 'Loading collections…' : 'Choose a collection' }}
      </option>
      <option v-for="c in collections" :key="c.id" :value="c.id">
        {{ c.title }}<template v-if="c.productsCount !== null"> ({{ c.productsCount }} products)</template>
      </option>
    </select>

    <p v-if="error" class="tiny" style="color: var(--critical)">{{ error }}</p>
    <p v-else-if="!loading && !collections.length" class="tiny subtle">
      No collections matched. Try a different search.
    </p>
  </div>
</template>
