<template>
  <div v-if="start">
    <div
      class="position-fixed w-100 h-100 z-l2 d-flex align-items-center justify-content-center"
    >
      <div class="spinner-grow text-warning" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
    </div>
    <div class="bg-black position-fixed w-100 h-100 z-l1 opacity-25"></div>
  </div>
  <div v-else class="page-loading">
    <div class="icon">
      <img src="@/assets/img/logo.svg" style="width: 70px;" />
    </div>
    <div class="spin">
      <div></div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from "vuex";

export default {
  name: "LoadingLayout",
  computed: {
    ...mapGetters(["start"]),
  },
};
</script>

<style scoped>
.z-l2 {
  z-index: 9002;
}
.z-l1 {
  z-index: 9000;
}

.page-loading {
  background: #000;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  position: absolute;
  z-index: 9999;
}
.page-loading .icon,
.page-loading .spin {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: absolute;
}
.page-loading .icon svg {
  width: 10vh;
  height: 10vh;
}
.page-loading .spin div {
  animation: spin 1s ease-in-out infinite;
  -webkit-animation: spin 0.75s linear infinite;
  position: fixed;
  border-radius: 50%;
  border: 2px solid #000;
  border-top: 2px solid #f8c800;
  border-bottom: 2px solid #0097d7;
  z-index: 1;
  width: 13vh;
  height: 13vh;
}
@keyframes spin {
  to {
    -webkit-transform: rotate(360deg);
  }
}
@-webkit-keyframes spin {
  to {
    -webkit-transform: rotate(360deg);
  }
}
</style>
