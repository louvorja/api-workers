<template>
  <alert danger v-if="error">{{ error }}</alert>
  <alert success v-if="success">{{ success }}</alert>

  <form-page
    v-model="data"
    :id="id"
    :messages="messages"
    :fields="fields"
    :insert_buttons="['insert', 'cancel']"
    :update_buttons="['insert_new', 'update', 'delete', 'cancel']"
    :can_insert="can_insert"
    :can_update="can_update"
    :can_delete="can_delete"
    :filter="filter"
    @button="actions"
  />

  <slot />

  <data-table
    v-model:refresh="refresh"
    :url="url"
    :sort_by="sort_by"
    :selected="selected"
    :can_view="can_view"
    :can_insert="can_insert"
    :can_update="can_update"
    :can_delete="can_delete"
    :filter="filter"
    @button="actions"
    :columns="[
      ...grid_columns,
      {
        buttons: ['edit', 'delete'],
      },
    ]"
  />
</template>

<script>
import Api from "@/services/Api";

import { mapMutations } from "vuex";
import Swal from "sweetalert2";

import DataTable from "@/components/DataTable.vue";
import FormPage from "@/components/Form.vue";
import Alert from "@/components/Alert.vue";

export default {
  name: "PageComponent",
  inheritAttrs: false,
  components: {
    DataTable,
    FormPage,
    Alert,
  },
  props: {
    url: String,
    id_field: String,
    fields: Array,
    grid_columns: Array,
    sort_by: String,
    filter: Object,
    can_view: Boolean,
    can_insert: Boolean,
    can_update: Boolean,
    can_delete: Boolean,
    selected: Boolean,
  },
  data() {
    return {
      loaded: false,
      refresh: false,
      error: "",
      success: "",
      id: null,
      messages: {},
      data: {},
    };
  },
  watch: {
    error(newValue) {
      if (newValue != "") {
        Swal.fire({
          title: newValue,
          icon: "error",
        });
      }
    },
    success(newValue) {
      if (newValue != "") {
        Swal.fire({
          title: newValue,
          icon: "success",
        });
      }
    },
    data() {
      this.emitData();
    },
  },
  methods: {
    ...mapMutations(["setLoading"]),
    reset_messages() {
      this.error = "";
      this.success = "";
      this.messages = {};
    },
    reset() {
      this.id = null;
      this.data = {};
    },
    actions(data) {
      console.log("btn", data);
      if (data.button == "edit") {
        this.reset();
        this.reset_messages();

        let self = this;
        this.setLoading(true);
        Api.get(
          `${this.url}/${data.data[this.id_field] ?? 0}`,
          {},
          function (resp, data) {
            self.setLoading(false);
            self.error = data.error ?? "";
            self.success = data.message ?? "";
            self.data = data.data ?? {};
            self.id = data.data ? data.data[self.id_field] ?? null : null;
          }
        );
      } else if (data.button == "insert" || data.button == "insert_new") {
        this.reset_messages();

        let self = this;
        this.setLoading(true);
        Api.post(`${this.url}`, this.data, function (resp, data) {
          self.setLoading(false);
          self.error = !data.messages ? data.error ?? "" : "";
          self.messages = Object.assign(self.messages, data.messages);
          self.success = data.message ?? "";

          if (resp) {
            self.data = data.data ?? {};
            self.id = data.data ? data.data[self.id_field] ?? null : null;
            self.refresh = true;
          }
        });
      } else if (data.button == "update") {
        this.reset_messages();

        let self = this;
        this.setLoading(true);
        Api.patch(
          `${this.url}/${data.data[this.id_field] ?? 0}`,
          this.data,
          function (resp, data) {
            self.setLoading(false);
            self.error = !data.messages ? data.error ?? "" : "";
            self.messages = Object.assign(self.messages, data.messages);
            self.success = data.message ?? "";

            if (resp) {
              self.data = data.data ?? {};
              self.id = data.data ? data.data[self.id_field] ?? null : null;
              self.refresh = true;
            }
          }
        );
      } else if (data.button == "delete") {
        let self = this;

        Swal.fire({
          title: "Deseja remover este registro?",
          showDenyButton: true,
          showCancelButton: false,
          confirmButtonText: "Sim",
          denyButtonText: "Não",
          icon: "warning",
        }).then((result) => {
          if (result.isConfirmed) {
            self.reset_messages();

            self.setLoading(true);
            Api.remove(
              `${this.url}/${data.data[this.id_field] ?? 0}`,
              function (resp, data) {
                self.setLoading(false);
                self.error = !data.messages ? data.error ?? "" : "";
                self.messages = Object.assign(self.messages, data.messages);
                self.success = data.message ?? "";

                if (resp) {
                  self.reset();
                  self.refresh = true;
                }
              }
            );
          }
        });
      } else if (data.button == "cancel") {
        this.reset();
        this.reset_messages();
      }
    },
    emitData() {
      this.$emit("update:modelValue", this.data);
    },
  },
};
</script>
