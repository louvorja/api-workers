<template>
  <title-page :mb="3">Componentes</title-page>

  <div class="card">
    <div class="card-body">
      <form-page
        v-model="data"
        :messages="{}"
        :fields="[
          [
            {
              name: 'disabled',
              label: 'disabled',
              disabled: true,
              col: [12, 6, 4, 4, 4, 3],
            },
            { name: 'text', label: 'text', col: [12, 6, 4, 4, 4, 3] },
            {
              type: 'number',
              name: 'number',
              label: 'number',
              col: [12, 6, 4, 4, 4, 3],
            },
            {
              type: 'color',
              name: 'color',
              label: 'color',
              col: [12, 6, 4, 4, 4, 3],
            },
            {
              type: 'library',
              category: 'image_album',
              name: 'library_image_album',
              label: 'library: image_album',
              col: [12, 6, 4, 4, 4, 3],
            },
            {
              type: 'library',
              category: 'image_music',
              name: 'library_image_music',
              label: 'library: image_music',
              col: [12, 6, 4, 4, 4, 3],
            },
            {
              type: 'library',
              category: 'music',
              name: 'library_music',
              label: 'library: music',
              col: [12, 12, 8, 8, 8, 9],
            },
            {
              type: 'lang',
              name: 'lang',
              label: 'lang',
              col: [12, 6, 4, 4, 4, 3],
            },
          ],
        ]"
        :insert_buttons="['insert', 'insert_new', 'update', 'delete', 'cancel']"
      />
      {{ data }}
    </div>
  </div>
</template>

<script>
import TitlePage from "@/components/Title.vue";
import FormPage from "@/components/Form.vue";

export default {
  name: "AlbumsPage",
  components: {
    TitlePage,
    FormPage,
  },
  data() {
    return {
      data: {},
    };
  },
};
</script>
