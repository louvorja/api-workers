<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/lyrics"
    id_field="id_lyric"
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
          name: 'id_lyric',
          label: 'ID',
          disabled: true,
          col: [12, 2],
        },
        {
          type: 'select_data',
          name: 'id_music',
          label: 'Música',
          options_url: 'admin/musics',
          options_label: 'name',
          options_key: 'id_music',
          options_params: { sort_by: 'name' },
          col: [12, 10],
        },
        {
          type: 'textarea',
          name: 'lyric',
          label: 'Letra',
          col: [12],
        },
        {
          name: 'aux_lyric',
          label: 'Letra Auxiliar',
          col: [12, 12, 6],
        },
        {
          type: 'library',
          category: 'image_music',
          name: 'id_file_image',
          label: 'Imagem',
          col: [12, 12, 6],
        },
        {
          type: 'time',
          name: 'time',
          label: 'Tempo',
          col: [12, 6],
        },
        {
          type: 'time',
          name: 'instrumental_time',
          label: 'Tempo Instrumental',
          col: [12, 6],
        },
        {
          type: 'boolean',
          name: 'show_slide',
          label: 'Exibe Slide?',
          col: [12, 4, 3],
        },
        {
          type: 'number',
          name: 'order',
          label: 'Ordem',
          col: [12, 8, 4],
        },
        {
          type: 'lang',
          name: 'id_language',
          label: 'Idioma',
          col: [12, 12, 5],
        },
      ],
    ]"
    sort_by="id_lyric.desc"
    :grid_columns="[
      { name: 'id_lyric', label: 'ID', type: 'number' },
      { name: 'music', label: 'Música' },
      { name: 'lyric', label: 'Letra' },
      { name: 'time', label: 'Tempo' },
      { name: 'instrumental_time', label: 'Tempo (PB)' },
      { name: 'show_slide', label: 'Exibe Slide?', type: 'boolean' },
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
  name: "LyricTable",
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
        (this.user.permissions ?? []).includes("lyrics") || this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("lyrics.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("lyrics.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("lyrics.delete") ||
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
