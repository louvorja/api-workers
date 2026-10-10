<template>
  <title-page :mb="3">Categorias</title-page>
  <div class="card">
    <div class="card-body">
      <category-table v-model="category">
        <collapse
          title="Álbuns"
          v-if="category.id_category"
          v-model="active_category"
        >
          <category-album-table
            v-if="active_category"
            :filter="{
              id_category: category.id_category,
            }"
          />
        </collapse>
      </category-table>
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import Collapse from "@/components/Collapse.vue";
import CategoryTable from "@/views/partials/CategoryTable.vue";
import CategoryAlbumTable from "@/views/partials/CategoryAlbumTable.vue";

export default {
  name: "CategoriesPage",
  components: {
    TitlePage,
    Collapse,
    CategoryTable,
    CategoryAlbumTable,
  },
  data() {
    return {
      category: {},
      active_category: false,
    };
  },
};
</script>
