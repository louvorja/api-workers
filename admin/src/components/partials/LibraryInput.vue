<template>
  <div
    v-if="category == 'music'"
    class="input-group-text flex-fill d-flex flex-column"
    style="width: 10px"
  >
    <div
      v-if="loading_item"
      class="spinner-border spinner-border-sm ms-2"
      role="status"
    >
      <span class="visually-hidden">Loading...</span>
    </div>
    <audio v-else-if="item.url" controls class="w-100" style="height: 32px">
      <source :src="item.url" />
      Audio não suportado
    </audio>

    <div
      v-if="error_item"
      class="d-block text-truncate text-start text-danger flex-fill small w-100"
    >
      {{ error_item }}
    </div>
    <div v-else class="d-block text-truncate text-start small w-100">
      {{ item.name ?? "" }}
    </div>
  </div>
  <div
    v-else
    class="input-group-text"
    style="width: 38px; height: 38px; padding: 3px"
  >
    <div
      v-if="loading_item"
      class="spinner-border spinner-border-sm ms-2"
      role="status"
    >
      <span class="visually-hidden">Loading...</span>
    </div>
    <a v-else-if="item.url" :href="item.url" target="_blank">
      <img :src="item.url" style="width: 100%; height: 100%" />
    </a>
  </div>

  <div
    v-if="error_item && category !== 'music'"
    class="input-group-text text-danger flex-fill d-block text-truncate text-start"
  >
    {{ error_item }}
  </div>
  <div
    v-else-if="category !== 'music'"
    class="input-group-text flex-fill d-block text-truncate text-start"
  >
    {{ item.name ?? "" }}
  </div>

  <modal
    v-model="show_library"
    :title="
      'Biblioteca | ' +
      (category == 'image_album'
        ? 'Imagens de Capa'
        : category == 'image_music'
        ? 'Imagens'
        : category == 'music'
        ? 'Músicas'
        : '')
    "
    :buttons="{
      remove: { label: 'Remover Imagem', color: 'danger' },
    }"
    @button="button_library"
    @scroll="scroll"
  >
    <alert danger v-if="error">{{ error }}</alert>

    <div
      v-if="data"
      class="d-flex flex-wrap align-items-center justify-content-between"
    >
      <div v-for="file in data" :key="file.id_file">
        <div
          v-if="category == 'music'"
          class="card border-left-primary shadow h-100 m-1"
          style="min-width: 350px"
        >
          <div class="card-body">
            <div class="row no-gutters align-items-center">
              <div class="col mr-2">
                <div
                  class="text-xs font-weight-bold text-primary text-truncate d-block text-uppercase"
                >
                  {{ file.name }}
                </div>
                <div
                  class="text-xs text-muted font-weight-bold text-primary text-truncate d-block mb-1"
                >
                  {{ file.subdirectory }}
                </div>
                <div class="btn-toolbar">
                  <div class="ms-auto"></div>
                  <a
                    :href="file.url"
                    target="_blank"
                    type="button"
                    class="btn btn-sm btn-info mx-1"
                  >
                    Ouvir
                  </a>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary mx-1"
                    @click="selectFile(file)"
                  >
                    Selecionar
                  </button>
                </div>
              </div>
              <div class="col-auto">
                <i class="fas fa-calendar fa-2x text-gray-300"></i>
              </div>
            </div>
          </div>
        </div>
        <a v-else href="javascript:" @click="selectFile(file)" class="m-2">
          <figure class="figure">
            <img
              :src="file.url"
              :alt="file.name"
              class="figure-img img-thumbnail"
              style="max-height: 130px"
            />
            <figcaption class="figure-caption text-center">
              {{ file.name }}
            </figcaption>
          </figure>
        </a>
      </div>
    </div>

    <div
      v-if="loading"
      class="d-flex align-items-center justify-content-center"
    >
      <div class="spinner-border text-secondary" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
    </div>
    <div v-if="next_page" class="p-4 w-100 text-center">
      <button class="btn btn-primary" @click="load()">Carregar mais</button>
    </div>
  </modal>

  <button
    v-if="value"
    class="btn btn-danger"
    type="button"
    @click="remove"
    :disabled="disabled"
  >
    <font-awesome-icon icon="x" />
  </button>
  <button
    class="btn btn-primary"
    type="button"
    @click="modal_library"
    :disabled="disabled"
  >
    <font-awesome-icon icon="search" />
  </button>
</template>

<script>
import Api from "@/services/Api";

import Modal from "@/components/Modal.vue";
import Alert from "@/components/Alert.vue";

export default {
  name: "LibraryInputComponent",
  components: {
    Modal,
    Alert,
  },
  inheritAttrs: false,
  props: {
    modelValue: Number,
    value: Number,
    id: String,
    category: String,
    disabled: Boolean,
  },
  data() {
    return {
      show_library: false,
      error: "",
      error_item: "",
      loading: false,
      loading_item: false,
      limit: 50,
      page: null,
      pages: null,
      next_page: 1,
      data: [],
      item: {},
      data_scroll: {},
      scroll_load: 50,
    };
  },
  watch: {
    value(value) {
      if (!value) {
        this.error_item = "";
        this.error = "";
        this.item = {};
      } else {
        this.load_item();
      }
    },
    show_library(value) {
      if (value) {
        this.load();
      }
    },
  },
  methods: {
    modal_library() {
      this.show_library = true;
    },
    button_library(val) {
      if (val == "remove") {
        this.remove();
      }
    },
    scroll(value) {
      this.data_scroll = value;
      if (!this.loading && value.bottom <= this.scroll_load) {
        this.load();
      }
    },
    remove() {
      this.file = {};
      this.$emit("input", null);
      this.show_library = false;
    },
    load() {
      if (this.next_page && this.show_library) {
        let self = this;
        this.error = "";
        this.loading = true;
        Api.get(
          "admin/files",
          {
            type: this.category,
            limit: this.limit,
            page: this.next_page,
            sort_by: "id_file.desc",
          },
          function (resp, data) {
            self.loading = false;
            self.error = data.error ?? "";
            if (resp) {
              self.page = data.current_page;
              self.pages = data.last_page;
              self.next_page = data.next_page_url
                ? data.current_page + 1
                : null;
              self.data.push(...(data.data ?? []));
            }
          }
        );
      }
    },
    load_item() {
      let self = this;
      this.error_item = "";
      this.loading_item = true;
      Api.get("admin/files/" + this.value, {}, function (resp, data) {
        self.loading_item = false;
        self.error_item = data.error ?? "";
        if (resp) {
          self.item = data.data ?? {};
        }
      });
    },
    selectFile(file) {
      this.item = file;
      this.show_library = false;
      this.$emit("input", file.id_file);
    },
  },
  mounted() {},
};
</script>
