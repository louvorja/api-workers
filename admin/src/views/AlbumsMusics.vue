<template>
  <title-page :mb="3">Músicas dos Álbuns</title-page>
  <div class="card">
    <div class="card-body">
      <album-music-table v-model="album_music">
        <collapse
          :title="
            'Album' +
            (album_music && album_music.album
              ? ' | ' + album_music.album.name
              : '')
          "
          v-if="album_music.id_album_music"
          v-model="active_album"
        >
          <album-table
            v-if="active_album"
            :filter="{
              id_album: album_music.id_album,
            }"
            selected
          />
        </collapse>
        <collapse
          :title="
            'Música' +
            (album_music && album_music.music
              ? ' | ' + album_music.music.name
              : '')
          "
          v-if="album_music.id_album_music"
          v-model="active_music"
        >
          <music-table
            v-if="active_music"
            :filter="{
              id_music: album_music.id_music,
            }"
            selected
          />
        </collapse>
      </album-music-table>
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import Collapse from "@/components/Collapse.vue";
import AlbumMusicTable from "@/views/partials/AlbumMusicTable.vue";
import AlbumTable from "@/views/partials/AlbumTable.vue";
import MusicTable from "@/views/partials/MusicTable.vue";

export default {
  name: "AlbumsMusicsPage",
  components: {
    TitlePage,
    Collapse,
    AlbumMusicTable,
    AlbumTable,
    MusicTable,
  },
  data() {
    return {
      album_music: {},
      active_music: false,
      active_album: false,
    };
  },
};
</script>
