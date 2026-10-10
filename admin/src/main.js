import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import store from "./store";

import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { fas } from "@fortawesome/free-solid-svg-icons";
library.add(fas);

import VueSweetalert2 from "vue-sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";

import "@/assets/scss/main.scss";
import "bootstrap/dist/js/bootstrap.bundle.min.js";

import vueSelect from "vue-select";
import "vue-select/dist/vue-select.css";

import FlagIcon from "vue-flag-icon";

createApp(App)
  .component("font-awesome-icon", FontAwesomeIcon)
  .component("vue-select", vueSelect)
  .use(router)
  .use(store)
  .use(VueSweetalert2)
  .use(FlagIcon)
  .mount("#app");
