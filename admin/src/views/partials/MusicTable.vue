<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/musics"
    id_field="id_music"
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
          name: 'id_music',
          label: 'ID',
          disabled: true,
          col: [12, 2, 2, 2, 2, 2],
        },
        { name: 'name', label: 'Nome', col: [12, 10, 10, 5, 5, 5] },
        {
          type: 'library',
          category: 'image_music',
          name: 'id_file_image',
          label: 'Imagem de Capa',
          col: [12, 12, 12, 5, 5, 5],
        },
        {
          type: 'library',
          category: 'music',
          name: 'id_file_music',
          label: 'Música',
          col: [12, 12, 12, 6],
        },
        {
          type: 'library',
          category: 'music',
          name: 'id_file_instrumental_music',
          label: 'Música - Playback',
          col: [12, 12, 12, 6],
        },
        {
          type: 'lang',
          name: 'id_language',
          label: 'Idioma',
          col: [12, 12, 12, 6],
        },
      ],
    ]"
    sort_by="name"
    :grid_columns="[
      { name: 'id_music', label: 'ID', type: 'number' },
      { name: 'name', label: 'Nome' },
      { name: 'url_music', label: 'Música', type: 'music' },
      {
        name: 'url_instrumental_music',
        label: 'Tem Playback?',
        type: 'boolean',
      },
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
  name: "MusicTable",
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
        (this.user.permissions ?? []).includes("musics") || this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("musics.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("musics.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("musics.delete") ||
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
