<template>
  <title-page :mb="3">Usuários</title-page>

  <div class="card">
    <div class="card-body">
      <user-table />
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import UserTable from "@/views/partials/UserTable.vue";

export default {
  name: "UsersPage",
  components: {
    TitlePage,
    UserTable,
  },
};
</script>
