<template>
  <title-page :mb="3">Álbuns</title-page>

  <div class="card">
    <div class="card-body">
      <album-table v-model="album">
        <collapse
          title="Categorias"
          v-if="album.id_album"
          v-model="active_album"
        >
          <category-album-table
            v-if="active_album"
            :filter="{
              id_album: album.id_album,
            }"
          />
        </collapse>
        <collapse title="Músicas" v-if="album.id_album" v-model="active_album">
          <album-music-table
            v-if="active_album"
            :filter="{
              id_album: album.id_album,
              sort_by: 'track',
            }"
          />
        </collapse>
      </album-table>
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import Collapse from "@/components/Collapse.vue";
import AlbumTable from "@/views/partials/AlbumTable.vue";
import CategoryAlbumTable from "@/views/partials/CategoryAlbumTable.vue";
import AlbumMusicTable from "@/views/partials/AlbumMusicTable.vue";

export default {
  name: "AlbumsPage",
  components: {
    TitlePage,
    Collapse,
    AlbumTable,
    CategoryAlbumTable,
    AlbumMusicTable,
  },
  data() {
    return {
      album: {},
      active_album: false,
    };
  },
};
</script>
