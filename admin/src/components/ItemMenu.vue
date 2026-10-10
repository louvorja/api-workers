<template>
  <li :class="['nav-item', { active }]">
    <router-link v-if="!hasSlot" class="nav-link" :to="href">
      <font-awesome-icon :icon="icon" class="icon" />
      <span>{{ label }}</span>
    </router-link>
    <a
      v-else
      :class="['nav-link', { collapsed: !show }]"
      data-bs-toggle="collapse"
      :href="'#' + id"
      role="button"
      aria-expanded="false"
      :aria-controls="id"
    >
      <font-awesome-icon :icon="icon" class="icon" />
      <span>{{ label }}</span>
      <font-awesome-icon icon="angle-right" class="arrow" />
    </a>

    <div v-if="hasSlot" :class="['collapse', { show }]" :id="id">
      <div class="bg-white py-2 collapse-inner rounded">
        <slot />
      </div>
    </div>
  </li>
</template>

<script>
export default {
  name: "ItemMenu",
  inheritAttrs: false,
  props: {
    label: String,
    icon: String,
    href: String,
    active: Boolean,
  },
  data() {
    return {
      id: `menu-${Math.random().toString(36).substr(2, 9)}`,
      width: 0,
    };
  },
  computed: {
    hasSlot() {
      return !!this.$slots.default;
    },
    show() {
      return this.active && this.width >= 768;
    },
  },
  mounted() {
    window.addEventListener("resize", this.resize);
    this.resize();
  },
  beforeUnmount() {
    window.removeEventListener("resize", this.resize);
  },
  methods: {
    resize() {
      this.width = window.innerWidth;
      this.$forceUpdate();
    },
  },
};
</script>

<style scoped>
.nav-link .icon {
  padding-right: 5px;
}

.nav-link .arrow {
  text-align: center;
  float: right;
  transition: transform 0.3s ease;
}
.nav-link:not(.collapsed) .arrow {
  transform: rotate(90deg);
}
@media (max-width: 767px) {
  .nav-link .arrow {
    display: none;
  }
}
</style>
