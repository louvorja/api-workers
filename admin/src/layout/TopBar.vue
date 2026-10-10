<template>
  <nav
    class="navbar navbar-expand navbar-light bg-white topbar mb-4 static-top shadow"
  >
    <!-- Topbar Navbar -->
    <ul class="navbar-nav ms-auto">
      <!--
      <li class="nav-item dropdown no-arrow mx-1">
        <a
          class="nav-link dropdown-toggle"
          href="#"
          id="alerts"
          role="button"
          data-bs-toggle="dropdown"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <font-awesome-icon icon="bell" />
          <span class="badge bg-danger badge-counter">3+</span>
        </a>
        <div
          class="dropdown-list dropdown-menu dropdown-menu-right shadow animated--grow-in"
          aria-labelledby="alerts"
        >
          <h6 class="dropdown-header">Alerts Center</h6>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="me-3">
              <div class="icon-circle bg-primary text-white">
                <font-awesome-icon icon="file-alt" />
              </div>
            </div>
            <div>
              <div class="small text-gray-500">December 12, 2019</div>
              <span class="font-weight-bold"
                >A new monthly report is ready to download!</span
              >
            </div>
          </a>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="me-3">
              <div class="icon-circle bg-success text-white">
                <font-awesome-icon icon="donate" />
              </div>
            </div>
            <div>
              <div class="small text-gray-500">December 7, 2019</div>
              $290.29 has been deposited into your account!
            </div>
          </a>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="me-3">
              <div class="icon-circle bg-warning text-white">
                <font-awesome-icon icon="exclamation-triangle" />
              </div>
            </div>
            <div>
              <div class="small text-gray-500">December 2, 2019</div>
              Spending Alert: We've noticed unusually high spending for your
              account.
            </div>
          </a>
          <a class="dropdown-item text-center small text-gray-500" href="#"
            >Show All Alerts</a
          >
        </div>
      </li>

      <li class="nav-item dropdown no-arrow mx-1">
        <a
          class="nav-link dropdown-toggle"
          href="#"
          id="messages"
          role="button"
          data-bs-toggle="dropdown"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <font-awesome-icon icon="envelope" />
          <span class="badge bg-danger badge-counter">7</span>
        </a>
        <div
          class="dropdown-list dropdown-menu dropdown-menu-right shadow animated--grow-in"
          aria-labelledby="messages"
        >
          <h6 class="dropdown-header">Message Center</h6>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="dropdown-list-image me-3">
              <avatar>AA</avatar>
            </div>
            <div class="font-weight-bold">
              <div class="text-truncate">
                Hi there! I am wondering if you can help me with a problem I've
                been having.
              </div>
              <div class="small text-gray-500">Emily Fowler · 58m</div>
            </div>
          </a>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="dropdown-list-image me-3">
              <avatar>JC</avatar>
            </div>
            <div>
              <div class="text-truncate">
                I have the photos that you ordered last month, how would you
                like them sent to you?
              </div>
              <div class="small text-gray-500">Jae Chun · 1d</div>
            </div>
          </a>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="dropdown-list-image me-3">
              <avatar>XX</avatar>
            </div>
            <div>
              <div class="text-truncate">
                Last month's report looks great, I am very happy with the
                progress so far, keep up the good work!
              </div>
              <div class="small text-gray-500">Morgan Alvarez · 2d</div>
            </div>
          </a>
          <a class="dropdown-item d-flex align-items-center" href="#">
            <div class="dropdown-list-image me-3">
              <avatar>DS</avatar>
            </div>
            <div>
              <div class="text-truncate">
                Am I a good boy? The reason I ask is because someone told me
                that people say this to all dogs, even if they aren't good...
              </div>
              <div class="small text-gray-500">Chicken the Dog · 2w</div>
            </div>
          </a>
          <a class="dropdown-item text-center small text-gray-500" href="#"
            >Read More Messages</a
          >
        </div>
      </li>
      -->

      <div class="topbar-divider d-none d-sm-block"></div>

      <li class="nav-item dropdown no-arrow">
        <a
          class="nav-link dropdown-toggle"
          href="javascript:"
          id="userDropdown"
          role="button"
          data-bs-toggle="dropdown"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <span class="me-2 d-none d-lg-inline text-gray-600 small">
            {{ user.short_name ?? "" }}
          </span>
          <avatar>{{ user.initials ?? "" }}</avatar>
        </a>
        <!-- Dropdown - User Information -->
        <div
          class="dropdown-menu dropdown-menu-right shadow animated--grow-in"
          aria-labelledby="userDropdown"
        >
          <router-link class="dropdown-item" to="/profile">
            <font-awesome-icon icon="user" />
            Dados Pessoais
          </router-link>
          <a class="dropdown-item" href="#">
            <font-awesome-icon icon="exclamation" />
            Settings
          </a>
          <a class="dropdown-item" href="#">
            <font-awesome-icon icon="list" />
            Activity Log
          </a>
          <div class="dropdown-divider"></div>
          <a class="dropdown-item" @click="logout()" href="#">
            <font-awesome-icon icon="sign-out-alt" />
            Logout
          </a>
        </div>
      </li>
    </ul>
  </nav>
</template>

<script>
import Auth from "@/controllers/Auth";

import { mapGetters } from "vuex";
import Avatar from "@/components/Avatar.vue";

export default {
  name: "TopBarLayout",
  components: {
    Avatar,
  },
  computed: {
    ...mapGetters(["user"]),
  },
  methods: {
    logout: async function () {
      let self = this;

      self.error = "";
      self.messages = null;
      Auth.logout();
    },
  },
};
</script>

<style scoped>
.dropdown-menu {
  right: 0 !important;
  left: auto !important;
}
.badge-counter {
  padding: 3px 5px;
}
</style>
