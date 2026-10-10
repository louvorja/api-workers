<template>
  <div
    :class="
      'form-group ' +
      (col ? ' col-' + col : '') +
      (colSm ? ' col-sm-' + colSm : '') +
      (colMd ? ' col-md-' + colMd : '') +
      (colLg ? ' col-lg-' + colLg : '') +
      (colXl ? ' col-xl-' + colXl : '') +
      (colXxl ? ' col-xxl-' + colXxl : '')
    "
  >
    <label :for="id" class="form-label">{{ label }}</label>
    <div
      v-if="loading"
      class="spinner-border spinner-border-sm ms-2"
      role="status"
    >
      <span class="visually-hidden">Loading...</span>
    </div>
    <div
      class="input-group flex-nowrap"
      :class="{
        'is-invalid': error_list,
      }"
    >
      <library-input
        v-if="type == 'library'"
        :id="id"
        :class="{
          'is-invalid': error_list,
        }"
        :category="category"
        :value="modelValue"
        :disabled="disabled || readonly || loading"
        @input="onFile"
      />
      <vue-select
        v-else-if="
          type == 'select' ||
          type == 'multiple' ||
          type == 'select_data' ||
          type == 'lang'
        "
        :multiple="type == 'multiple'"
        :options="local_options"
        class="w-100"
        :class="{
          'is-invalid': error_list,
        }"
        :id="id"
        :modelValue="selectValue"
        :selectable="
          (option) =>
            modelValue && type == 'multiple'
              ? !modelValue.includes(option.code)
              : true
        "
        :disabled="disabled || readonly || loading"
        @update:modelValue="onSelect"
      />
      <textarea
        v-else-if="type == 'textarea'"
        class="form-control"
        :class="{
          'is-invalid': error_list,
        }"
        :id="id"
        :aria-describedby="id + 'Help'"
        :value="modelValue"
        :disabled="disabled || readonly || loading"
        ref="textarea"
        @input="onInput"
      />
      <div v-else-if="type == 'boolean'" class="form-check form-switch">
        <input
          type="checkbox"
          class="form-check-input"
          :class="{
            'is-invalid': error_list,
          }"
          :id="id"
          :aria-describedby="id + 'Help'"
          :checked="modelValue"
          :disabled="disabled || readonly || loading"
          @change="onCheck"
        />
        <label class="form-check-label" :for="id">
          <span v-if="modelValue">Sim</span>
          <span v-else>Não</span>
        </label>
      </div>
      <input
        v-else
        :type="type && type != 'color' ? type : 'text'"
        class="form-control"
        :class="{
          'is-invalid': error_list,
        }"
        :id="id"
        :aria-describedby="id + 'Help'"
        :value="modelValue"
        :disabled="disabled || readonly || loading"
        :step="type == 'number' || type == 'time' ? 1 : 0"
        @input="onInput"
      />
      <input
        v-if="type == 'color'"
        type="color"
        class="input-group-text"
        style="width: 38px; height: 38px; padding: 3px"
        :value="modelValue ?? '#000000'"
        :disabled="disabled || readonly || loading"
        @input="onInput"
      />
    </div>
    <div v-if="help" :id="id + 'Help'" class="form-text">
      {{ help }}
    </div>
    <div v-if="error_list" class="invalid-feedback">
      <div v-for="(message, index) in error_list" :key="index">
        {{ message }}
      </div>
    </div>
  </div>
</template>

<script>
import Api from "@/services/Api";
import Langs from "@/helpers/Langs";

import LibraryInput from "@/components/partials/LibraryInput.vue";

import { v4 as uuidv4 } from "uuid";

export default {
  name: "InputComponent",
  components: {
    LibraryInput,
  },
  inheritAttrs: false,
  props: {
    modelValue: [String, Array, Number, Boolean],
    label: String,
    type: String,
    help: String,
    error: [String, Array],
    options: Array,
    options_url: String,
    options_label: String,
    options_key: String,
    options_params: Object,
    disabled: Boolean,
    readonly: Boolean,
    category: String,
    col: Number,
    colSm: Number,
    colMd: Number,
    colLg: Number,
    colXl: Number,
    colXxl: Number,
  },
  data() {
    return {
      id: uuidv4(),
      local_options: [],
      loading: false,
      error_field: "",
    };
  },
  watch: {
    modelValue() {
      this.adjustHeight();
    },
  },
  computed: {
    error_list() {
      let err = [];
      if (this.error) {
        if (typeof this.error === "string") {
          err = [this.error];
        } else {
          err = this.error;
        }
      } else {
        err = [];
      }
      err = [...err, this.error_field].filter((item) => {
        return item;
      });
      if (err.length > 0) {
        return err;
      }
      return null;
    },
    selectValue() {
      let null_value = this.type == "multiple" ? [] : "";

      if (!this.modelValue) {
        return null_value;
      }

      if (this.local_options) {
        return this.local_options.filter((item) => {
          if (this.type == "multiple") {
            return this.modelValue.includes(item.code);
          } else {
            return this.modelValue == item.code;
          }
        });
      } else {
        return null_value;
      }
    },
    langs() {
      return Langs.list();
    },
  },
  methods: {
    onInput: function (event) {
      this.$emit("update:modelValue", event.target.value);
      this.adjustHeight();
    },
    onCheck: function (event) {
      this.$emit("update:modelValue", event.target.checked);
    },
    onSelect: function (value) {
      let emit;
      if (this.type == "multiple") {
        emit = [];
        emit = value.map((item) => {
          if (typeof item == "object") {
            return item.code ?? "";
          }
          return item;
        });
      } else {
        emit = null;
        if (value) {
          if (typeof value == "object") {
            emit = value.code ?? "";
          } else {
            emit = value;
          }
        }
      }
      this.$emit("update:modelValue", emit);
    },
    onFile: function (value) {
      this.$emit("update:modelValue", value);
    },
    adjustHeight() {
      if (this.type == "textarea") {
        let textarea = this.$refs.textarea;
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight + 2}px`;
      }
    },
    loadOptions: function () {
      let self = this;
      this.error_field = "";
      this.loading = true;
      Api.get(
        this.options_url ?? "",
        Object.assign(this.options_params ?? {}, { limit: -1 }),
        function (resp, data) {
          self.loading = false;
          self.error_field = data.error ?? "";
          if (resp) {
            self.local_options = data.data.map((item) => {
              return {
                label:
                  (item[self.options_key] ?? "") +
                  " - " +
                  (item[self.options_label] ?? ""),
                code: item[self.options_key] ?? "",
              };
            });
          }
        }
      );
    },
  },
  mounted() {
    if (this.type == "lang") {
      this.local_options = Langs.list();
    } else if (this.type == "select_data") {
      this.loadOptions();
    } else {
      this.local_options = this.options ?? [];
    }
  },
};
</script>
