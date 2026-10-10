<template>
  <ul
    class="navbar-nav bg-gradient-primary sidebar sidebar-dark accordion"
    id="accordionSidebar"
  >
    <!-- Sidebar - Brand -->
    <a
      class="sidebar-brand d-flex align-items-center justify-content-center"
      href="/"
    >
      <div class="sidebar-brand-icon">
        <img src="@/assets/img/logo.svg" style="height: 60px" />
      </div>
      <div class="sidebar-brand-text mx-3">
        <div>Louvor JA</div>
        <div style="font-weight: 100">CPanel</div>
      </div>
    </a>

    <hr class="sidebar-divider my-0" />

    <item-menu
      label="Dashboard"
      icon="tachometer-alt"
      href="/"
      :active="route == '/'"
    />

    <hr class="sidebar-divider" />

    <div class="sidebar-heading">APLICAÇÃO</div>

    <item-menu
      v-if="
        this.user.is_admin || (this.user.permissions ?? []).includes('users')
      "
      :active="['/users'].includes(route)"
      label="Acessos"
      icon="wrench"
    >
      <router-link
        v-if="
          this.user.is_admin || (this.user.permissions ?? []).includes('users')
        "
        :class="{ active: route == '/users' }"
        to="/users"
        class="collapse-item"
      >
        Usuários
      </router-link>
    </item-menu>

    <item-menu
      v-if="
        this.user.is_admin ||
        (this.user.permissions ?? []).includes('categories') ||
        (this.user.permissions ?? []).includes('categories_albums') ||
        (this.user.permissions ?? []).includes('albums') ||
        (this.user.permissions ?? []).includes('albums_musics')
      "
      :active="
        [
          '/categories',
          '/categories_albums',
          '/albums',
          '/albums_musics',
        ].includes(route)
      "
      label="Grupos"
      icon="compact-disc"
    >
      <h6
        v-if="
          this.user.is_admin ||
          (this.user.permissions ?? []).includes('categories') ||
          (this.user.permissions ?? []).includes('categories_albums')
        "
        class="collapse-header"
      >
        Categorias:
      </h6>
      <router-link
        v-if="
          this.user.is_admin ||
          (this.user.permissions ?? []).includes('categories')
        "
        :class="{ active: route == '/categories' }"
        to="/categories"
        class="collapse-item"
      >
        Categorias
      </router-link>
      <router-link
        v-if="
          this.user.is_admin ||
          (this.user.permissions ?? []).includes('categories_albums')
        "
        :class="{ active: route == '/categories_albums' }"
        to="/categories_albums"
        class="collapse-item"
      >
        Álbuns das Categorias
      </router-link>

      <h6
        v-if="
          this.user.is_admin ||
          (this.user.permissions ?? []).includes('albums') ||
          (this.user.permissions ?? []).includes('albums_musics')
        "
        class="collapse-header"
      >
        Álbuns:
      </h6>
      <router-link
        v-if="
          this.user.is_admin || (this.user.permissions ?? []).includes('albums')
        "
        :class="{ active: route == '/albums' }"
        to="/albums"
        class="collapse-item"
      >
        Álbuns
      </router-link>
      <router-link
        v-if="
          this.user.is_admin ||
          (this.user.permissions ?? []).includes('albums_musics')
        "
        :class="{ active: route == '/albums_musics' }"
        to="/albums_musics"
        class="collapse-item"
      >
        Músicas dos Álbuns
      </router-link>
    </item-menu>

    <item-menu
      v-if="
        this.user.is_admin ||
        (this.user.permissions ?? []).includes('musics') ||
        (this.user.permissions ?? []).includes('lyrics')
      "
      :active="['/musics', '/lyrics'].includes(route)"
      label="Músicas"
      icon="music"
    >
      <router-link
        v-if="
          this.user.is_admin || (this.user.permissions ?? []).includes('musics')
        "
        :class="{ active: route == '/musics' }"
        to="/musics"
        class="collapse-item"
      >
        Músicas
      </router-link>
      <router-link
        v-if="
          this.user.is_admin || (this.user.permissions ?? []).includes('lyrics')
        "
        :class="{ active: route == '/lyrics' }"
        to="/lyrics"
        class="collapse-item"
      >
        Letras
      </router-link>
    </item-menu>

<!--
    <item-menu label="Utilitários" icon="wrench">
      <a class="collapse-item" href="utilities-color.html">Idiomas</a>
      <a class="collapse-item" href="utilities-border.html">Arquivos</a>
    </item-menu>
-->
    <!-- Divider -->
    <hr class="sidebar-divider" />
  </ul>
</template>

<script>
import ItemMenu from "@/components/ItemMenu.vue";

import { mapGetters } from "vuex";

export default {
  name: "SideBarLayout",
  components: {
    ItemMenu,
  },
  computed: {
    route() {
      return this.$route.path;
    },
    ...mapGetters(["user"]),
  },
};
</script>
