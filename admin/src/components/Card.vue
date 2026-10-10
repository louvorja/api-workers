<template>
  <div class="col-xl-3 col-md-6 mb-4">
    <div
      :class="'card border-left-' + (color ?? 'primary') + ' shadow h-100 py-2'"
    >
      <div class="card-body">
        <div class="row no-gutters align-items-center">
          <div class="col mr-2">
            <div
              :class="
                'text-xs font-weight-bold text-' +
                (color ?? 'primary') +
                ' text-uppercase mb-1'
              "
            >
              {{ label }}
            </div>
            <div class="h5 mb-0 text-gray-800">
              <slot />
            </div>
            <div class="text-end" v-if="linkLabel">
              <a
                href="javascript:"
                :class="'mb-0 text-' + (color ?? 'primary')"
                @click="handleClick"
              >
                {{ linkLabel }}
              </a>
            </div>
          </div>
          <div class="col-auto fa-2x text-gray-300">
            <font-awesome-icon :icon="icon" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: "CardComponent",
  inheritAttrs: false,
  props: {
    label: String,
    icon: String,
    color: String,
    linkLabel: String,
    click: Function,
  },
  methods: {
    handleClick(event) {
      if (this.click) {
        this.click(event);
      }
    },
  },
};
</script>
