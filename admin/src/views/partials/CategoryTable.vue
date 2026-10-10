<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/categories"
    id_field="id_category"
    :filter="filter"
    :selected="selected"
    :can_view="can_view"
    :can_insert="can_insert"
    :can_update="can_update"
    :can_delete="can_delete"
    :fields="[
      [
        {
          type: 'number',
          name: 'id_category',
          label: 'ID',
          disabled: true,
          col: [12, 2, 2, 2, 2, 2],
        },
        { name: 'name', label: 'Nome', col: [12, 10, 10, 5, 5, 5] },
        { name: 'slug', label: 'Nome na Url', col: [12, 12, 12, 5, 5, 5] },
        {
          name: 'order',
          type: 'number',
          label: 'Ordem',
          col: [12, 4],
        },
        {
          name: 'type',
          label: 'Tipo',
          col: [12, 4],
        },
        {
          type: 'lang',
          name: 'id_language',
          label: 'Idioma',
          col: [12, 4],
        },
      ],
    ]"
    sort_by="name"
    :grid_columns="[
      { name: 'id_category', label: 'ID', type: 'number' },
      { name: 'name', label: 'Nome' },
      { name: 'slug', label: 'Url' },
      { name: 'order', label: 'Ordem', type: 'number' },
      { name: 'type', label: 'Tipo' },
      { name: 'id_language', label: 'Idioma', type: 'flag' },
    ]"
  >
    <slot />
  </page>
</template>

<script>
import { mapGetters } from "vuex";

import Page from "@/components/Page.vue";

export default {
  name: "CategoryTable",
  props: { filter: Object, selected: Boolean },
  components: {
    Page,
  },
  data() {
    return {
      data: {},
      loaded: false,
    };
  },
  computed: {
    can_view() {
      return (
        (this.user.permissions ?? []).includes("categories") ||
        this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("categories.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("categories.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("categories.delete") ||
        this.user.is_admin
      );
    },
    ...mapGetters(["loading", "user"]),
  },
  watch: {
    loading(newValue) {
      if (!newValue) {
        this.loaded = true;
      }
    },
    data() {
      this.emitData();
    },
  },
  methods: {
    emitData() {
      this.$emit("update:modelValue", this.data);
    },
  },
  mounted() {
    if (!this.loading) {
      this.loaded = true;
    }
  },
};
</script>
