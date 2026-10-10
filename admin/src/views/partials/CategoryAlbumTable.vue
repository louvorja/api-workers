<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/categories_albums"
    id_field="id_category_album"
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
          name: 'id_category_album',
          label: 'ID',
          disabled: true,
          col: [12, 2, 2, 2, 2, 2],
        },
        {
          type: 'select_data',
          name: 'id_category',
          label: 'Categoria',
          options_url: 'admin/categories',
          options_label: 'name',
          options_key: 'id_category',
          options_params: { sort_by: 'name' },
          col: [12, 10, 10, 5, 5, 5],
        },
        {
          type: 'select_data',
          name: 'id_album',
          label: 'Álbum',
          options_url: 'admin/albums',
          options_label: 'name',
          options_key: 'id_album',
          options_params: { sort_by: 'name' },
          col: [12, 12, 12, 5, 5, 5],
        },
        { name: 'name', label: 'Título', col: [12, 12, 12, 5] },
        {
          name: 'order',
          type: 'number',
          label: 'Ordem',
          col: [12, 4, 4, 2],
        },
        {
          type: 'lang',
          name: 'id_language',
          label: 'Idioma',
          col: [12, 8, 8, 5],
        },
      ],
    ]"
    sort_by="category_name"
    :grid_columns="[
      { name: 'id_category_album', label: 'ID', type: 'number' },
      { name: 'category_name', label: 'Categoria' },
      { name: 'album_name', label: 'Álbum' },
      { name: 'name', label: 'Título' },
      { name: 'order', label: 'Ordem', type: 'number' },
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
  name: "CategoryAlbumTable",
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
        (this.user.permissions ?? []).includes("categories_albums") ||
        this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("categories_albums.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("categories_albums.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("categories_albums.delete") ||
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
