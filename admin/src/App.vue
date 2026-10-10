<template>
  <loading v-if="loading" />
  <div v-if="auth && start" id="wrapper">
    <side-bar />
    <div id="content-wrapper" class="d-flex flex-column">
      <div id="content">
        <top-bar />
        <div class="container-fluid">
          <alert
            warning
            v-if="user.is_temporary_password && $route.path != '/profile'"
          >
            Você está acessando o sistema através de uma senha provisória!
            <br />É necessário alterar sua senha antes de utilizar o sistema.
            <br /><router-link to="/profile">Clique aqui</router-link>
            para alterar sua senha.
          </alert>
          <alert warning v-else-if="user.is_temporary_password">
            Altere sua senha clicando no link "alterar senha" no card de
            Usuário!
          </alert>
          <router-view />
        </div>
      </div>
      <footer-page />
    </div>
  </div>
  <login v-else-if="start" />
</template>

<script>
import { mapGetters } from "vuex";

import Loading from "./layout/Loading.vue";
import SideBar from "./layout/SideBar.vue";
import TopBar from "./layout/TopBar.vue";
import FooterPage from "./layout/Footer.vue";

import Alert from "./components/Alert.vue";

import Login from "./views/Login.vue";

export default {
  name: "App",
  components: {
    SideBar,
    TopBar,
    FooterPage,
    Loading,
    Login,

    Alert,
  },
  computed: {
    ...mapGetters(["start", "loading", "auth", "user"]),
  },
};
</script>
