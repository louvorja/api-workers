<template>
  <title-page>Dados Pessoais</title-page>

  <p class="mb-3">
    Caso algum dado esteja incorreto, entre em contato com o administrador e
    solicite correção.
  </p>

  <div class="row">
    <card label="Nome" icon="user">{{ user.name }}</card>
    <card
      label="Usuário"
      icon="address-card"
      color="warning"
      link-label="alterar senha"
      :click="modal_change_password"
    >
      {{ user.username }}
    </card>
    <card label="E-mail" icon="envelope" color="info">
      {{ user.email }}
    </card>
    <card label="Telefone" icon="phone" color="success">{{ user.phone }}</card>
  </div>

  <modal
    v-model="show_change_password"
    title="Alterar Senha"
    :buttons="{
      save: 'Alterar Senha',
    }"
    @button="button_change_password"
  >
    <alert danger v-if="error">{{ error }}</alert>
    <alert success v-if="success">{{ success }}</alert>

    <form @submit.prevent="submit" @keydown.enter="submit">
      <form-group>
        <input-field
          label="Senha atual"
          type="password"
          v-model="password.current_password"
          :error="messages.current_password"
          :col="12"
          :col-lg="4"
        />
        <input-field
          label="Nova senha"
          type="password"
          v-model="password.new_password"
          :error="messages.new_password"
          :col="12"
          :col-sm="6"
          :col-lg="4"
        />
        <input-field
          label="Confirme a nova senha"
          type="password"
          v-model="password.new_password_confirmation"
          :error="messages.new_password_confirmation"
          :col="12"
          :col-sm="6"
          :col-lg="4"
        />
      </form-group>
    </form>
  </modal>
</template>

<script>
import Auth from "@/controllers/Auth";

import { mapGetters } from "vuex";

import TitlePage from "@/components/Title.vue";
import Card from "@/components/Card.vue";
import FormGroup from "@/components/FormGroup.vue";
import InputField from "@/components/Input.vue";
import Modal from "@/components/Modal.vue";
import Alert from "@/components/Alert.vue";

export default {
  name: "ProfilePage",
  components: {
    TitlePage,
    Card,
    FormGroup,
    InputField,
    Modal,
    Alert,
  },
  data() {
    return {
      show_change_password: false,
      password: {
        current_password: "",
        new_password: "",
        new_password_confirmation: "",
      },
      error: "",
      success: "",
      messages: {
        current_password: null,
        new_password: null,
        new_password_confirmation: null,
      },
    };
  },
  computed: {
    ...mapGetters(["user"]),
  },
  watch: {
    show_change_password() {
      this.reset_messages();
      this.reset();
    },
  },
  methods: {
    reset_messages() {
      this.error = "";
      this.success = "";
      this.messages = {
        current_password: null,
        new_password: null,
        new_password_confirmation: null,
      };
    },
    reset() {
      this.password = {
        current_password: "",
        new_password: "",
        new_password_confirmation: "",
      };
    },
    modal_change_password() {
      this.show_change_password = true;
    },
    button_change_password(val) {
      if (val == "save") {
        this.change_password();
      }
    },
    change_password() {
      this.reset_messages();
      let self = this;

      Auth.changePassword(this.password, function (resp, data) {
        if (!resp) {
          self.error = !data.messages ? data.error : "";
          self.messages = Object.assign(self.messages, data.messages);
        } else {
          self.success = data.message;
          self.reset();
        }
      });
    },
    submit() {
      this.change_password();
    },
  },
};
</script>
