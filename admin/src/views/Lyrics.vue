<template>
  <title-page :mb="3">Letras</title-page>

  <div class="card">
    <div class="card-body">
      <lyric-table v-model="lyric">
        <collapse title="Música" v-if="lyric.id_lyric" v-model="active_lyric">
          <music-table
            v-if="active_lyric"
            :filter="{
              id_music: lyric.id_music,
            }"
            selected
          />
        </collapse>
      </lyric-table>
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import Collapse from "@/components/Collapse.vue";
import LyricTable from "@/views/partials/LyricTable.vue";
import MusicTable from "@/views/partials/MusicTable.vue";

export default {
  name: "LyricsPage",
  components: {
    TitlePage,
    Collapse,
    LyricTable,
    MusicTable,
  },
  data() {
    return {
      lyric: {},
      active_lyric: false,
    };
  },
};
</script>
