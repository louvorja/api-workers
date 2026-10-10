import { createRouter, createWebHistory } from "vue-router";

import Auth from "@/controllers/Auth.js";

const routes = [
  {
    path: "/",
    name: "Home",
    component: () => import("../views/Home.vue"),
  },
  {
    path: "/profile",
    name: "Profile",
    component: () => import("../views/Profile.vue"),
  },
  {
    path: "/users",
    name: "Users",
    component: () => import("../views/Users.vue"),
  },
  {
    path: "/categories",
    name: "Categories",
    component: () => import("../views/Categories.vue"),
  },
  {
    path: "/categories_albums",
    name: "CategoriesAlbums",
    component: () => import("../views/CategoriesAlbums.vue"),
  },
  {
    path: "/albums",
    name: "Albums",
    component: () => import("../views/Albums.vue"),
  },
  {
    path: "/albums_musics",
    name: "AlbumsMusics",
    component: () => import("../views/AlbumsMusics.vue"),
  },
  {
    path: "/musics",
    name: "Musics",
    component: () => import("../views/Musics.vue"),
  },
  {
    path: "/lyrics",
    name: "Lyrics",
    component: () => import("../views/Lyrics.vue"),
  },

  {
    path: "/components",
    name: "Components",
    component: () => import("../views/Components.vue"),
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL ?? "/"),
  routes,
});

router.beforeEach((to, from, next) => {
  Auth.refresh();
  next();
});

export default router;
