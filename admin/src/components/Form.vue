<template>
  <div v-for="(row, index) in fields" :key="index" class="row">
    <input-field
      v-for="(field, index) in row"
      :key="index"
      v-model="data[field.name]"
      :label="field.label ?? ''"
      :type="field.type ?? 'text'"
      :error="messages[field.name] ?? ''"
      :help="field.help ?? ''"
      :options="field.options ?? []"
      :options_url="field.options_url"
      :options_label="field.options_label"
      :options_key="field.options_key"
      :options_params="field.options_params"
      :category="field.category ?? ''"
      :disabled="field.disabled ?? false"
      :readonly="this.filter && this.filter[field.name] ? true : false"
      :col="field.col ? field.col[0] ?? 0 : 0"
      :col-sm="field.col ? field.col[1] ?? 0 : 0"
      :col-md="field.col ? field.col[2] ?? 0 : 0"
      :col-lg="field.col ? field.col[3] ?? 0 : 0"
      :col-xl="field.col ? field.col[4] ?? 0 : 0"
      :col-xxl="field.col ? field.col[5] ?? 0 : 0"
    />
  </div>

  <div class="btn-toolbar mt-2 mb-3">
    <div class="ms-auto"></div>
    <button
      v-for="button in buttonsList(id ? update_buttons : insert_buttons)"
      :key="button.id"
      type="button"
      class="ms-2 btn"
      :disabled="
        !(button.id == 'edit'
          ? can_view ?? true
          : button.id == 'insert' || button.id == 'insert_new'
          ? can_insert ?? true
          : button.id == 'update'
          ? can_update ?? true
          : button.id == 'delete'
          ? can_delete ?? true
          : true)
      "
      :class="
        button.color
          ? 'btn-' + button.color
          : button.id == 'insert' || button.id == 'insert_new'
          ? 'btn-primary'
          : button.id == 'update'
          ? 'btn-success'
          : button.id == 'delete'
          ? 'btn-danger'
          : button.id == 'cancel'
          ? 'btn-warning'
          : 'btn-primary'
      "
      @click="clickButton(button.id)"
    >
      <font-awesome-icon
        v-if="
          button.icon ||
          button.id == 'insert' ||
          button.id == 'insert_new' ||
          button.id == 'update' ||
          button.id == 'delete' ||
          button.id == 'cancel'
        "
        :icon="
          button.icon
            ? button.icon
            : button.id == 'insert' || button.id == 'insert_new'
            ? 'plus'
            : button.id == 'update'
            ? 'save'
            : button.id == 'delete'
            ? 'trash'
            : button.id == 'cancel'
            ? 'ban'
            : ''
        "
      />
      {{
        button.label
          ? button.label
          : button.id == "insert"
          ? "Inserir"
          : button.id == "insert_new"
          ? "Inserir como Novo"
          : button.id == "update"
          ? "Salvar"
          : button.id == "delete"
          ? "Excluir"
          : button.id == "cancel"
          ? "Cancelar"
          : ""
      }}
    </button>
  </div>
</template>

<script>
import InputField from "@/components/Input.vue";

export default {
  name: "FormComponent",
  components: {
    InputField,
  },
  inheritAttrs: false,
  props: {
    modelValue: Object,
    id: Number,
    messages: Object,
    fields: Array,
    insert_buttons: Array,
    update_buttons: Array,
    col: Array,
    disabled: Boolean,
    filter: Object,
    can_insert: {
      type: Boolean,
      default: true,
    },
    can_update: {
      type: Boolean,
      default: true,
    },
    can_delete: {
      type: Boolean,
      default: true,
    },
  },
  data() {
    return {
      data: {},
    };
  },
  watch: {
    modelValue(value) {
      this.data = Object.assign({}, value, this.filter);
    },
  },
  methods: {
    buttonsList(buttons) {
      if (buttons) {
        return buttons.map((item) => {
          if (typeof item === "string") {
            return { id: item };
          } else {
            return item;
          }
        });
      } else {
        return [];
      }
    },
    clickButton(button) {
      this.$emit("update:modelValue", this.data);
      this.$emit("button", { button, data: this.modelValue });
    },
  },
  mounted() {
    if (this.filter) {
      this.data = Object.assign({}, this.filter);
    }
  },
};
</script>
