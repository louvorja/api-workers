<template>
  <div
    class="d-sm-flex align-items-center justify-content-between"
    :class="mb ? 'mb-' + mb : ''"
  >
    <h1 class="h3 mb-0 text-gray-800"><slot /></h1>
  </div>
</template>

<script>
export default {
  name: "TitleComponent",
  inheritAttrs: false,
  props: {
    mb: Number,
  },
};
</script>
