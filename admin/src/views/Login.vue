<template>
  <div
    class="bg-gradient-primary w-100 d-flex align-items-center justify-content-center"
    style="min-height: 100vh"
  >
    <div class="container">
      <div class="row justify-content-center">
        <div class="col-xl-10 col-lg-12 col-md-9">
          <div class="card o-hidden border-0 shadow-lg my-5">
            <div class="card-body p-0">
              <div class="row">
                <div
                  class="col-lg-6 d-none d-lg-flex bg-login-image align-items-center justify-content-center flex-column"
                >
                  <img src="@/assets/img/logo.svg" style="height: 50%" />
                  <div class="sidebar-brand-text mx-3 text-center">
                    <h1 class="text-center text-primary p-0 m-0">Louvor JA</h1>
                    <h4 class="text-center p-0 m-0" style="font-weight: 100">
                      CPanel
                    </h4>
                  </div>
                </div>
                <div class="col-lg-6">
                  <div class="p-5">
                    <div class="text-center">
                      <h1 class="h4 text-gray-900 mb-4">
                        Forneça suas credenciais!
                      </h1>
                    </div>

                    <alert danger v-if="error">{{ error }}</alert>

                    <form
                      @submit.prevent="submit"
                      @keydown.enter="submit"
                      class="user"
                    >
                      <div class="form-group mb-2">
                        <input
                          type="text"
                          class="form-control form-control-user"
                          :class="{
                            'is-invalid': messages && messages.username,
                          }"
                          placeholder="Nome de Usuário"
                          v-model="user.username"
                        />
                        <div
                          v-if="messages && messages.username"
                          class="invalid-feedback"
                        >
                          <div
                            v-for="(message, index) in messages.username"
                            :key="index"
                          >
                            {{ message }}
                          </div>
                        </div>
                      </div>
                      <div class="form-group mb-3">
                        <input
                          type="password"
                          class="form-control form-control-user"
                          :class="{
                            'is-invalid': messages && messages.password,
                          }"
                          placeholder="Senha"
                          v-model="user.password"
                        />
                        <div
                          v-if="messages && messages.password"
                          class="invalid-feedback"
                        >
                          <div
                            v-for="(message, index) in messages.password"
                            :key="index"
                          >
                            {{ message }}
                          </div>
                        </div>
                      </div>

                      <button
                        @click="login()"
                        class="btn btn-primary btn-user btn-block w-100"
                      >
                        Conectar
                      </button>
                    </form>
                    <!--
                    <hr />
                    <div class="text-center">
                      Precisa de ajuda?
                      <a
                        class="small"
                        href="forgot-password.html"
                        target="_blank"
                      >
                        Fale com o Suporte
                      </a>
                    </div>
                    -->
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import Auth from "@/controllers/Auth";

import Alert from "@/components/Alert.vue";

export default {
  name: "LoginPage",
  components: {
    Alert,
  },
  data() {
    return {
      user: {
        username: "",
        password: "",
      },
      error: "",
      messages: {
        username: null,
        password: null,
      },
    };
  },
  methods: {
    login: async function () {
      let self = this;

      self.error = "";
      self.messages = {
        username: null,
        password: null,
      };
      Auth.login(this.user, function (resp, data) {
        if (!resp) {
          self.error = !data.messages ? data.error : "";
          self.messages = Object.assign(self.messages, data.messages);
        }
      });
    },
    submit() {
      this.login();
    },
  },
};
</script>

<style scoped>
.form-control-user {
  height: 50px;
}
</style>
