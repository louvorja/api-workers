<template>
  <div class="avatar">
    <slot />
  </div>
</template>

<script>
export default {
  name: "AvatarComponent",
  inheritAttrs: false,
  props: {
    label: String,
    icon: String,
    href: String,
    active: Boolean,
  },
};
</script>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.3rem;
  height: 2.3rem;
  border-radius: 50%;
  background-color: #007bff;
  color: white;
  font-weight: bold;
  font-size: 0.9rem;
  text-align: center;
}
</style>
