<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  suggestions: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Type a tag and press Enter' },
});
const emit = defineEmits(['update:modelValue']);

const inputEl = ref(null);
const draft = ref('');
const focused = ref(false);
const activeIndex = ref(-1);

const filtered = computed(() => {
  const q = draft.value.trim().toLowerCase();
  const chosen = new Set(props.modelValue.map((t) => t.toLowerCase()));
  return props.suggestions
    .filter((t) => !chosen.has(String(t).toLowerCase()))
    .filter((t) => (q ? String(t).toLowerCase().includes(q) : true))
    .slice(0, 8);
});

const showList = computed(() => focused.value && filtered.value.length > 0);

function add(tag) {
  const value = String(tag ?? '').trim();
  if (!value) return;
  if (!props.modelValue.some((t) => t.toLowerCase() === value.toLowerCase())) {
    emit('update:modelValue', [...props.modelValue, value]);
  }
  draft.value = '';
  activeIndex.value = -1;
}

function remove(index) {
  const next = props.modelValue.slice();
  next.splice(index, 1);
  emit('update:modelValue', next);
}

function focusInput() {
  inputEl.value?.focus();
}

// Delay so a mousedown on a suggestion still registers before the list hides.
function onBlur() {
  window.setTimeout(() => {
    focused.value = false;
    activeIndex.value = -1;
  }, 150);
}

function onKeydown(event) {
  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      add(activeIndex.value >= 0 ? filtered.value[activeIndex.value] : draft.value);
      break;
    case ',':
    case 'Tab':
      if (draft.value.trim()) {
        event.preventDefault();
        add(draft.value);
      }
      break;
    case 'Backspace':
      if (draft.value === '' && props.modelValue.length) remove(props.modelValue.length - 1);
      break;
    case 'ArrowDown':
      event.preventDefault();
      if (filtered.value.length) activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (filtered.value.length) {
        activeIndex.value =
          activeIndex.value <= 0 ? filtered.value.length - 1 : activeIndex.value - 1;
      }
      break;
    case 'Escape':
      focused.value = false;
      activeIndex.value = -1;
      break;
  }
}
</script>

<template>
  <div class="suggestions">
    <div class="taginput" @click="focusInput">
      <span v-for="(tag, i) in modelValue" :key="tag" class="chip">
        {{ tag }}
        <button type="button" :aria-label="`Remove tag ${tag}`" @click.stop="remove(i)">×</button>
      </span>
      <input
        ref="inputEl"
        v-model="draft"
        type="text"
        autocomplete="off"
        :placeholder="modelValue.length ? 'Add another' : placeholder"
        @focus="focused = true"
        @blur="onBlur"
        @keydown="onKeydown"
      />
    </div>

    <div v-if="showList" class="suggestions-list">
      <button
        v-for="(tag, i) in filtered"
        :key="tag"
        type="button"
        :class="{ active: i === activeIndex }"
        @mousedown.prevent="add(tag)"
      >
        {{ tag }}
      </button>
    </div>
  </div>
</template>
