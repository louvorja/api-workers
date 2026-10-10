<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/albums_musics"
    id_field="id_album_music"
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
          name: 'id_album_music',
          label: 'ID',
          disabled: true,
          col: [12, 2, 2, 2, 2, 2],
        },
        {
          type: 'select_data',
          name: 'id_album',
          label: 'Álbum',
          options_url: 'admin/albums',
          options_label: 'name',
          options_key: 'id_album',
          options_params: { sort_by: 'name' },
          col: [12, 10, 10, 5, 5, 5],
        },
        {
          type: 'select_data',
          name: 'id_music',
          label: 'Música',
          options_url: 'admin/musics',
          options_label: 'name',
          options_key: 'id_music',
          options_params: { sort_by: 'name' },
          col: [12, 12, 12, 5, 5, 5],
        },
        {
          name: 'track',
          type: 'number',
          label: 'Faixa',
          col: [12, 4, 4, 4],
        },
        {
          type: 'lang',
          name: 'id_language',
          label: 'Idioma',
          col: [12, 8, 8, 8],
        },
      ],
    ]"
    sort_by="album_name"
    :grid_columns="[
      { name: 'id_album_music', label: 'ID', type: 'number' },
      { name: 'album_name', label: 'Álbum' },
      { name: 'music_name', label: 'Música' },
      { name: 'track', label: 'Faixa', type: 'number' },
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
  name: "AlbumMusicTable",
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
        (this.user.permissions ?? []).includes("albums_musics") ||
        this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("albums_musics.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("albums_musics.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("albums_musics.delete") ||
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
