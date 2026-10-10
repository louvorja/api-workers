<template>
  <div
    class="modal fade"
    :id="id"
    tabindex="-1"
    :aria-labelledby="id + 'Label'"
    aria-hidden="true"
  >
    <div
      class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable"
    >
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" :id="id + 'Label'">{{ title }}</h5>
          <button
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            aria-label="Close"
          ></button>
        </div>
        <div class="modal-body" ref="modalBody">
          <slot />
        </div>
        <div class="modal-footer">
          <button
            v-for="(button, key) in buttons_list"
            :key="key"
            type="button"
            :class="'btn btn-' + (button.color ?? 'primary')"
            @click="clickButton(button.id)"
          >
            {{ button.label ?? "" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
<script>
import Modal from "bootstrap/js/dist/modal";
import { v4 as uuidv4 } from "uuid";

export default {
  name: "ModalComponent",
  inheritAttrs: false,
  props: {
    modelValue: Boolean,
    title: String,
    buttons: Object,
  },
  data() {
    return {
      id: uuidv4(),
      modalInstance: null,
      modalElement: null,
    };
  },
  computed: {
    buttons_list() {
      if (this.buttons) {
        return Object.keys(this.buttons).map((item) => {
          if (typeof this.buttons[item] === "string") {
            return { id: item, label: this.buttons[item] };
          } else {
            return { id: item, ...this.buttons[item] };
          }
        });
      } else {
        return [];
      }
    },
  },
  watch: {
    modelValue(value) {
      if (value) {
        this.openModal();
      } else if (this.modalInstance) {
        this.modalInstance.hide();
      }
    },
  },
  methods: {
    openModal() {
      if (this.modalInstance) {
        this.modalInstance.show();
      }
    },
    onModalHide() {
      this.$emit("update:modelValue", false);
    },
    clickButton(button) {
      this.$emit("button", button);
    },
    onResize() {
      let self = this;
      setTimeout(function () {
        self.onScroll();
      }, 100);
    },
    onScroll(event) {
      const scrollTop = event
        ? event.target.scrollTop
        : this.$refs.modalBody.scrollTop;
      const scrollHeight = event
        ? event.target.scrollHeight
        : this.$refs.modalBody.scrollHeight;
      const clientHeight = event
        ? event.target.clientHeight
        : this.$refs.modalBody.clientHeight;
      const scrollBottom = scrollHeight - (scrollTop + clientHeight);

      this.$emit("scroll", {
        top: scrollTop,
        bottom: scrollBottom,
        height: scrollHeight,
      });
    },
  },
  mounted() {
    this.modalElement = document.getElementById(this.id);
    if (this.modalElement) {
      this.modalInstance = new Modal(this.modalElement);
      this.modalElement.addEventListener("hidden.bs.modal", this.onModalHide);
    }
    if (this.show) {
      this.openModal();
    }
    this.$refs.modalBody.addEventListener("scroll", this.onScroll);

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(this.$refs.modalBody);

    this.onScroll();
    this.onResize();
  },
  beforeUnmount() {
    if (this.modalElement) {
      try {
        this.modalElement.removeEventListener(
          "hidden.bs.modal",
          this.onModalHide
        );
      } catch (error) {
        console.error("Failed to remove event listener:", error);
      }
    }
    this.$refs.modalBody.removeEventListener("scroll", this.onScroll);
    this.$refs.modalBody.removeEventListener("scroll", this.onScroll);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  },
};
</script>
