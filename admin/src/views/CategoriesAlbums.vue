<template>
  <title-page :mb="3">Álbuns das Categorias</title-page>
  <div class="card">
    <div class="card-body">
      <category-album-table v-model="category_album">
        <collapse
          :title="
            'Categoria' +
            (category_album && category_album.category
              ? ' | ' + category_album.category.name
              : '')
          "
          v-if="category_album.id_category_album"
          v-model="active_category"
        >
          <category-table
            v-if="active_category"
            :filter="{
              id_category: category_album.id_category,
            }"
            selected
          />
        </collapse>
        <collapse
          :title="
            'Album' +
            (category_album && category_album.album
              ? ' | ' + category_album.album.name
              : '')
          "
          v-if="category_album.id_category_album"
          v-model="active_album"
        >
          <album-table
            v-if="active_album"
            :filter="{
              id_album: category_album.id_album,
            }"
            selected
          />
        </collapse>
      </category-album-table>
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import Collapse from "@/components/Collapse.vue";
import CategoryAlbumTable from "@/views/partials/CategoryAlbumTable.vue";
import AlbumTable from "@/views/partials/AlbumTable.vue";
import CategoryTable from "@/views/partials/CategoryTable.vue";

export default {
  name: "CategoriesAlbumsPage",
  components: {
    TitlePage,
    Collapse,
    CategoryAlbumTable,
    AlbumTable,
    CategoryTable,
  },
  data() {
    return {
      category_album: {},
      active_category: false,
      active_album: false,
    };
  },
};
</script>
