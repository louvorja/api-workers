<template>
  <div class="card mb-4">
    <a
      class="d-block card-header py-3 text-decoration-none"
      data-bs-toggle="collapse"
      :href="'#' + id"
      role="button"
      aria-expanded="false"
      :aria-controls="id"
      @click="toggleCollapse"
    >
      <h6 class="m-0 font-weight-bold text-primary">
        {{ title }}
      </h6>
    </a>

    <div class="collapse" :id="id">
      <div class="card-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<script>
import { v4 as uuidv4 } from "uuid";

export default {
  name: "CollapseComponent",
  inheritAttrs: false,
  props: {
    title: String,
    modelValue: Boolean,
  },
  data() {
    return {
      id: uuidv4(),
      isCollapsed: true,
    };
  },
  methods: {
    monitorCollapse() {
      this.$emit("update:modelValue", false);
      const collapseElement = this.$el.querySelector(".collapse");

      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.attributeName === "class") {
            const hasShowClass = collapseElement.classList.contains("show");
            this.$emit("update:modelValue", hasShowClass);
          }
        });
      });

      observer.observe(collapseElement, { attributes: true });
    },
  },
  mounted() {
    this.monitorCollapse();
  },
};
</script>
