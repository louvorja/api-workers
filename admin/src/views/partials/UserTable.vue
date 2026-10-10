<template>
  <page
    v-if="loaded"
    v-model="data"
    url="admin/users"
    id_field="id"
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
          name: 'id',
          label: 'ID',
          disabled: true,
          col: [12, 2, 2, 2, 2, 2],
        },
        { name: 'name', label: 'Nome', col: [12, 10, 10, 5, 5, 5] },
        { name: 'email', label: 'E-mail', col: [12, 12, 12, 5, 5, 5] },
        {
          name: 'username',
          label: 'Nome de Usuário',
          col: [12, 6, 6, 6, 6, 6],
        },
        {
          type: 'password',
          name: 'password',
          label: 'Senha Provisória',
          help: 'Deixe em branco para não alterar',
          col: [12, 6, 6, 6, 6, 6],
        },
        {
          type: 'multiple',
          name: 'permissions',
          label: 'Permissões',
          options: [
            { label: 'users | Usuários', code: 'users' },
            {
              label: 'users.insert | Usuários - Cadastro',
              code: 'users.insert',
            },
            {
              label: 'users.update | Usuários - Alteração',
              code: 'users.update',
            },
            {
              label: 'users.delete | Usuários - Exclusão',
              code: 'users.delete',
            },
            { label: 'categories | Categorias', code: 'categories' },
            {
              label: 'categories.insert | Categorias - Cadastro',
              code: 'categories.insert',
            },
            {
              label: 'categories.update | Categorias - Alteração',
              code: 'categories.update',
            },
            {
              label: 'categories.delete | Categorias - Exclusão',
              code: 'categories.delete',
            },
            {
              label: 'categories_albums | Álbuns das Categorias',
              code: 'categories_albums',
            },
            {
              label:
                'categories_albums.insert | Álbuns das Categorias - Cadastro',
              code: 'categories_albums.insert',
            },
            {
              label:
                'categories_albums.update | Álbuns das Categorias - Alteração',
              code: 'categories_albums.update',
            },
            {
              label:
                'categories_albums.delete | Álbuns das Categorias - Exclusão',
              code: 'categories_albums.delete',
            },
            { label: 'albums | Álbuns', code: 'albums' },
            {
              label: 'albums.insert | Álbuns - Cadastro',
              code: 'albums.insert',
            },
            {
              label: 'albums.update | Álbuns - Alteração',
              code: 'albums.update',
            },
            {
              label: 'albums.delete | Álbuns - Exclusão',
              code: 'albums.delete',
            },
            {
              label: 'albums_musics | Músicas dos Álbuns',
              code: 'albums_musics',
            },
            {
              label: 'albums_musics.insert | Músicas dos Álbuns - Cadastro',
              code: 'albums_musics.insert',
            },
            {
              label: 'albums_musics.update | Músicas dos Álbuns - Alteração',
              code: 'albums_musics.update',
            },
            {
              label: 'albums_musics.delete | Músicas dos Álbuns - Exclusão',
              code: 'albums_musics.delete',
            },
            { label: 'musics | Músicas', code: 'musics' },
            {
              label: 'musics.insert | Músicas - Cadastro',
              code: 'musics.insert',
            },
            {
              label: 'musics.update | Músicas - Alteração',
              code: 'musics.update',
            },
            {
              label: 'musics.delete | Músicas - Exclusão',
              code: 'musics.delete',
            },
            { label: 'lyrics | Letras', code: 'lyrics' },
            {
              label: 'lyrics.insert | Letras - Cadastro',
              code: 'lyrics.insert',
            },
            {
              label: 'lyrics.update | Letras - Alteração',
              code: 'lyrics.update',
            },
            {
              label: 'lyrics.delete | Letras - Exclusão',
              code: 'lyrics.delete',
            },
          ],
          col: [12],
        },
      ],
    ]"
    sort_by="name"
    :grid_columns="[
      { name: 'id', label: 'ID', type: 'number' },
      { name: 'name', label: 'Nome' },
      { name: 'username', label: 'Usuário' },
      { name: 'email', label: 'Email' },
      { name: 'phone', label: 'Telefone' },
      {
        name: 'is_temporary_password',
        label: 'Senha Provisória?',
        type: 'boolean',
      },
    ]"
  >
    <slot />
  </page>
</template>

<script>
import { mapGetters } from "vuex";

import Page from "@/components/Page.vue";

export default {
  name: "UserTable",
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
        (this.user.permissions ?? []).includes("users") || this.user.is_admin
      );
    },
    can_insert() {
      return (
        (this.user.permissions ?? []).includes("users.insert") ||
        this.user.is_admin
      );
    },
    can_update() {
      return (
        (this.user.permissions ?? []).includes("users.update") ||
        this.user.is_admin
      );
    },
    can_delete() {
      return (
        (this.user.permissions ?? []).includes("users.delete") ||
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
