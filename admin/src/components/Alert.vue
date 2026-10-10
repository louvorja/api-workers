<template>
  <div
    :class="{
      alert: true,
      'alert-primary': primary,
      'alert-secondary': secondary,
      'alert-success': success,
      'alert-danger': danger,
      'alert-warning': warning,
      'alert-info': info,
      'alert-light': light,
      'alert-dark': dark,
    }"
    role="alert"
  >
    <slot />
  </div>
</template>

<script>
export default {
  name: "AlertComponent",
  inheritAttrs: false,
  props: {
    primary: Boolean,
    secondary: Boolean,
    success: Boolean,
    danger: Boolean,
    warning: Boolean,
    info: Boolean,
    light: Boolean,
    dark: Boolean,
  },
};
</script>
